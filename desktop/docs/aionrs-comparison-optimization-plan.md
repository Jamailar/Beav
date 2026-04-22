---
doc_type: plan
execution_status: completed
execution_stage: completed
last_updated: 2026-04-22
owner: ai-runtime
scope: desktop
target_files:
  - desktop/src-tauri/src/runtime/*
  - desktop/src-tauri/src/agent/*
  - desktop/src-tauri/src/tools/*
  - desktop/src-tauri/src/skills/*
  - desktop/src-tauri/src/provider_compat/*
  - desktop/src-tauri/src/mcp/*
  - desktop/src-tauri/src/persistence/*
  - desktop/src/bridge/ipcRenderer.ts
  - desktop/src/runtime/runtimeEventStream.ts
  - desktop/src/pages/Chat.tsx
  - desktop/src/pages/RedClaw.tsx
  - desktop/src/pages/Settings.tsx
success_metrics:
  - runtime contract and approval flow are unified across chat, redclaw, daemon, and background jobs
  - provider-specific conditionals are reduced and centralized in provider_compat
  - memory becomes an independent subsystem instead of mixed workspace_data and maintenance logic
  - host/runtime critical paths gain dedicated integration tests
---

# RedBox 对比 aionrs 后的优化计划

Status: Completed

## Execution Result

本计划已按底层收口顺序执行完成，对应原子提交如下：

1. `5639f898` `Refactor provider compatibility policy handling`
2. `8125ddc4` `refactor(desktop): unify runtime approval and event contracts`
3. `136fdbf9` `refactor(desktop): extract memory into dedicated subsystem`
4. `49fa6f03` `refactor(desktop): add runtime approval state`
5. `463e7182` `refactor(desktop): formalize runtime context bundle`

本次执行后的实际结果：

- `provider_compat` 已收口为统一 turn policy，provider 差异不再散落在主流程条件分支里。
- `runtime event`、`approval payload`、`manuscripts confirm` 已走统一 contract 和宿主状态。
- `memory` 已从 `workspace_data + maintenance` 组合中拆成独立子系统。
- `approval runtime` 已统一承接 `runtime query`、`tool confirm`、`package script confirm`，并在 Settings diagnostics 中可见。
- `context bundle` 已形成类型化 summary，并随 `runtime warm` diagnostics 暴露给 Settings。
- 本计划相关关键链路已补齐聚焦测试：provider policy、runtime contract、memory recall、approval runtime、context bundle。

## Scope

这份计划只覆盖 `desktop/` 的 AI 内核、宿主协议和相关前端消费层，不覆盖：

- `Plugin/` 浏览器插件
- `RedBoxweb/` 官网/下载站
- `archive/desktop-electron/`
- 与本次优化无关的视觉 UI 改版

目标不是把 `aionrs` 迁进来，而是吸收它在以下方面的优点：

1. 模块边界清晰
2. Provider 兼容层稳定
3. Memory 独立成系统
4. Approval 是运行时能力，不是零散 confirm
5. 测试分层完整

最终要保留 RedBox 的产品优势：

- 知识库
- Wander
- Manuscripts / 视频编辑 / Remotion
- Media / Cover / Subjects / Archives
- RedClaw / Workboard / daemon

一句话：借它的内核治理，不削我们的产品链路。

## Why This Plan Exists

对比 `aionrs` 后，RedBox 当前最明显的结构性问题不是“缺功能”，而是这些能力还没有完全收成稳定底座：

- runtime contract 仍然分散在 `commands/*`、`events/*`、bridge 和历史 channel 兼容层
- provider 差异虽然已有 `provider_compat/`，但颗粒度还不够
- memory 已经存在，但更像“workspace_data + maintenance + prompt 片段”的组合
- approval 仍是点状命令与页面交互，尚未成为统一 runtime 子系统
- host/runtime 缺稳定测试带，复杂升级成本高

`aionrs` 已经验证了一件事：当 agent 内核复杂到需要 skills、mcp、memory、tool approval、subagent、plan、compact 共存时，必须先把内核边界做硬，产品才能继续扩。

## Comparison Summary

| 领域 | aionrs 的强项 | RedBox 当前状态 | 优化方向 |
| --- | --- | --- | --- |
| 类型与协议 | `types + protocol + agent` 分层清晰 | runtime/event/ipc contract 分散 | 收口统一 runtime contract |
| provider 兼容 | compat 是一等模块 | 已有 `provider_compat/`，但偏轻 | 扩成行为兼容层 |
| memory | 独立 crate | 已有 memory 能力，但未彻底系统化 | 独立 memory 子系统 |
| approval | 工具审批是主循环能力 | 零散 confirm / hold / 文档先行 | 建 runtime approval 子系统 |
| context 装配 | system prompt 构造集中 | context/memory/skills/prompt 仍分散 | 建 context bundle 装配层 |
| tests | 单测 + crate 集成 + workspace 回归 | 核心 host/runtime 测试弱 | 建分层测试矩阵 |

## Architecture Options

### Option A

继续在现有目录内做小修补。

优点：

- 改动最小
- 不影响当前发版节奏

缺点：

- 只能缓解，不会真正解决 contract、memory、approval 的结构问题
- `main.rs`、`commands/*`、`Settings.tsx`、`Manuscripts.tsx` 的复杂度还会继续堆积

### Option B

直接仿照 `aionrs`，把 Rust 宿主拆成多个 workspace crate。

优点：

- 分层最干净
- 从包边界上强制治理依赖方向

缺点：

- 对当前 Tauri 应用的工程摩擦太大
- 会显著拖慢产品研发
- 现阶段收益不如成本

### Option C

先保持 `desktop/src-tauri/src/` 单 workspace，不动 Cargo 形态，但把模块边界按 `aionrs` 的方式重构清楚；等边界稳定后，再评估是否拆 crate。

优点：

- 风险最可控
- 能最快改善运行时治理
- 不阻断现有产品开发

缺点：

- 包级隔离没有一步到位
- 需要更严格的目录和 contract 纪律

## Selected Architecture

选择 `Option C`。

原因：

1. RedBox 是重产品桌面应用，不是纯 CLI agent。
2. 当前最缺的是“稳定内核边界”，不是“更多 crate 数量”。
3. 先在现有 Tauri 宿主中把边界收紧，ROI 最高。

## Target Architecture

优化完成后，桌面端 AI 内核应稳定成下面这套结构：

```text
Renderer UI
  ├─ Chat / Wander / RedClaw / Settings / Workboard
  ├─ ipcRenderer facade
  └─ runtimeEventStream

Host Runtime Kernel
  ├─ runtime/contracts
  ├─ runtime/context_bundle
  ├─ runtime/approval_runtime
  ├─ runtime/session_runtime
  ├─ runtime/task_runtime
  ├─ runtime/orchestration_runtime
  ├─ agent/*
  └─ subagents/*

Capability Layer
  ├─ provider_compat/*
  ├─ tools/*
  ├─ skills/*
  ├─ mcp/*
  └─ memory/*

Persistence Layer
  ├─ persistence/*
  ├─ workspace_loaders.rs
  ├─ knowledge_index/*
  └─ scheduler/*
```

关键原则：

- 页面不直接理解 provider 差异
- 命令层不直接维护审批状态机
- memory 不再混在 workspace_data 和 settings fallback 中
- runtime event / session / task / approval 统一使用 typed contract

## Workstream 1: Runtime Contract 收口

### Goal

把当前散落在 `commands/*`、`events/*`、bridge、renderer 的 runtime 协议统一成一个稳定 contract 层。

### Current Problems

- 事件协议有 `runtime:event`，也有大量 `chat:*`、`creative-chat:*`、局部自定义事件
- session、task、checkpoint、tool result、approval 等 payload 没有统一 envelope
- 前端很多页面需要自己理解宿主字段形态

### Target Files

- `desktop/src-tauri/src/runtime/types.rs`
- `desktop/src-tauri/src/runtime/contracts.rs`（新增）
- `desktop/src-tauri/src/runtime/events.rs`
- `desktop/src-tauri/src/events/*`
- `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src/runtime/runtimeEventStream.ts`

### Implementation

新增或收口以下 contract：

- `RuntimeEventEnvelope`
- `RuntimeSessionSummary`
- `RuntimeTaskSummary`
- `RuntimeCheckpointSummary`
- `RuntimeToolResultSummary`
- `RuntimeApprovalSummary`
- `RuntimeContextBundleSummary`

约束：

1. host 统一发 `runtime:event` 及少量明确的系统事件
2. 兼容事件只在 `events/` 内映射，不允许页面继续直接依赖历史事件格式
3. renderer 只消费 bridge 归一化后的对象，不直接猜字段

### Must Use Existing Libraries

- `serde`
- Tauri event API

### Must Be Self-Implemented

- runtime event envelope
- session/task/approval 摘要结构
- bridge normalize/fallback 策略

### Verification

- `Chat`、`RedClaw`、`Settings`、`Workboard` 至少各验证一次事件消费
- 多 session 并行下事件不串页
- 老事件兼容仍能工作，但 UI 内部只消费新 contract

## Workstream 2: ProviderCompat 升级为行为兼容层

### Goal

把模型供应商差异从命令层、prompt 层、零散 if/else 中继续抽离到 `provider_compat/`。

### Current Problems

- 已有 [provider_compat/capabilities.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/provider_compat/capabilities.rs)，但主要还是 capability 布尔位
- 更细的行为差异仍可能散落在：
  - `runtime/config_runtime.rs`
  - `provider_runtime/*`
  - `llm_transport/*`
  - 各命令域对 tool choice / thinking 的处理

### Target Files

- `desktop/src-tauri/src/provider_compat/capabilities.rs`
- `desktop/src-tauri/src/provider_compat/registry.rs`
- `desktop/src-tauri/src/provider_compat/policy.rs`（新增）
- `desktop/src-tauri/src/provider_runtime/*`
- `desktop/src-tauri/src/llm_transport/*`
- `desktop/src-tauri/src/runtime/config_runtime.rs`

### Implementation

把 provider 差异统一收成：

- `message normalization policy`
- `tool choice policy`
- `thinking policy`
- `usage trailer policy`
- `parallel tool calls policy`
- `schema sanitize policy`
- `fallback text policy`

建议新增：

```rust
pub struct ProviderBehaviorPolicy {
    pub merge_same_role_messages: bool,
    pub dedup_tool_results: bool,
    pub sanitize_schema: bool,
    pub requires_disable_thinking_for_required_tool_choice: bool,
    pub supports_parallel_tool_calls: bool,
    pub supports_reasoning_effort: bool,
    pub supports_usage_trailer: bool,
}
```

### Must Use Existing Libraries

- 现有 `llm_transport`
- 现有 `provider_runtime`

### Must Be Self-Implemented

- provider behavior policy
- request/response normalize pipeline

### Verification

- OpenAI-compatible 主链路
- Anthropic / Gemini /其他当前支持的 provider profile
- Wander 的 forced tool choice + thinking 禁用链路
- Settings 页模型探测与实际请求表现一致

## Workstream 3: Memory 独立成子系统

### Goal

把当前 memory 从“workspace_data + maintenance + settings fallback + prompt 使用”的组合，升级成真正独立的运行时子系统。

### Current Problems

- [memory_maintenance.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/memory_maintenance.rs) 已经很重
- memory 的 store、history、maintenance、summary markdown、prompt 注入没有清晰边界
- renderer 只知道一组 `memory:*` IPC，但底层并不够模块化

### Target Files

- `desktop/src-tauri/src/memory/mod.rs`（新增）
- `desktop/src-tauri/src/memory/types.rs`（新增）
- `desktop/src-tauri/src/memory/store.rs`（新增）
- `desktop/src-tauri/src/memory/recall.rs`（新增）
- `desktop/src-tauri/src/memory/maintenance.rs`（从旧文件迁出）
- `desktop/src-tauri/src/memory/prompt.rs`（新增）
- `desktop/src-tauri/src/commands/workspace_data.rs`
- `desktop/src-tauri/src/runtime/context_bundle.rs`（新增）

### Implementation

按四层组织：

1. `store`
   - memory catalog
   - history
   - workspace 路径
   - `MEMORY.md`
2. `recall`
   - 为 runtime 提供 recall API
   - 返回 summary，而不是原始全量对象
3. `maintenance`
   - 维护计划、状态、LLM 管理器 prompt
4. `prompt`
   - 把 memory 转成 runtime 可消费的上下文片段

建议 memory 至少分三层类型：

- `user profile / creator profile`
- `durable memory`
- `ephemeral memory summary`

### Must Use Existing Libraries

- `serde_json`
- 文件系统

### Must Be Self-Implemented

- memory schema
- recall ranking / summary format
- maintenance policy

### Verification

- `memory:list/search/add/delete/history`
- `memory:maintenance-run/status`
- Chat / RedClaw / daemon 至少一处使用 memory recall
- memory 不再依赖 settings 内嵌 fallback JSON

## Workstream 4: Approval Runtime 统一

### Goal

把 tool confirm、script confirm、后台 hold、subagent approval 收成统一的审批运行时，而不是零散交互点。

### Current Problems

- 已有 `ai:confirm-tool`、`chat:confirm-tool`、`manuscripts:confirm-package-script`
- capability/approval 文档已经较完整
- 但 runtime 级 approval queue 还没有成为稳定实现

### Target Files

- `desktop/src-tauri/src/runtime/approval_runtime.rs`（新增）
- `desktop/src-tauri/src/tools/guards.rs`
- `desktop/src-tauri/src/commands/chat.rs`
- `desktop/src-tauri/src/commands/runtime_orchestration.rs`
- `desktop/src-tauri/src/commands/manuscripts.rs`
- `desktop/src/pages/Chat.tsx`
- `desktop/src/pages/RedClaw.tsx`
- `desktop/src/pages/Workboard.tsx`
- `desktop/src/pages/Settings.tsx`

### Implementation

统一审批数据结构：

- `approval_id`
- `source_kind`
- `source_session_id`
- `source_task_id`
- `tool_name`
- `action_summary`
- `risk_level`
- `approval_status`
- `requested_at`
- `resolved_at`
- `resolution_reason`

统一行为：

1. 前台对话请求审批
2. RedClaw/后台任务请求审批
3. subagent 请求审批
4. 审批结果回流 runtime，并触发继续执行/终止/降级

Renderer 至少提供一个统一审批面板，不再只靠瞬时弹窗。

### Must Use Existing Libraries

- 现有 `tools/guards.rs`
- 现有 runtime event 流

### Must Be Self-Implemented

- approval queue
- approval state machine
- UI 汇总视图

### Verification

- Chat 中高风险工具可挂起并恢复
- RedClaw 后台任务遇到 explicit approval 时不会偷偷继续跑
- script confirm 与 tool confirm 最终走同一套状态机

## Workstream 5: Context Bundle 装配层

### Goal

把 system prompt 相关的上下文组装从分散逻辑，收成稳定的 context bundle。

### Current Problems

- workspace rules、skills、memory、provider profile、runtime mode 提示词的来源不够集中
- 前端和宿主对“本轮上下文由哪些部分组成”可见性弱

### Target Files

- `desktop/src-tauri/src/runtime/context_bundle.rs`（新增）
- `desktop/src-tauri/src/skills/prompt.rs`
- `desktop/src-tauri/src/memory/prompt.rs`
- `desktop/src-tauri/src/provider_compat/*`
- `desktop/src/pages/Settings.tsx`

### Implementation

Bundle 组成建议固定为：

- workspace rules
- user / creator profile
- memory summary
- active skills summary
- provider behavior summary
- runtime mode guidance
- tool pack summary

对 renderer 暴露一个只读 diagnostics summary，而不是把全部 prompt 原文扔给 UI。

### Must Use Existing Libraries

- 现有 prompt 资产系统

### Must Be Self-Implemented

- context bundle schema
- fingerprint / cache 策略

### Verification

- Settings 页能看到本轮 runtime 的 context bundle 摘要
- skills、memory、provider profile 变化后 bundle 能正确失效重建

## Workstream 6: 测试矩阵补齐

### Goal

建立类似 `aionrs` 的分层测试，而不是继续依赖人工回归。

### Current Problems

- 官网有 `release-sync` 测试
- vendored FreeCut 自带很多测试
- 但核心 host/runtime/skills/tools/memory/provider compat 缺专门测试带

### Target Test Layers

1. Rust 模块内单测
2. Rust host 集成测试
3. renderer 侧最小事件/bridge 测试

### Target Paths

- `desktop/src-tauri/tests/runtime_contract_test.rs`（新增）
- `desktop/src-tauri/tests/provider_compat_test.rs`（新增）
- `desktop/src-tauri/tests/memory_e2e_test.rs`（新增）
- `desktop/src-tauri/tests/approval_runtime_test.rs`（新增）
- `desktop/src-tauri/tests/skills_hooks_test.rs`（新增）
- `desktop/src/runtime/__tests__/runtimeEventStream.test.ts`（新增）
- `desktop/src/bridge/__tests__/ipcRenderer.test.ts`（新增）

### Implementation

优先覆盖这些高风险链路：

- runtime event envelope
- provider behavior policy
- memory store + recall + maintenance status
- approval queue create / resolve / replay
- skill hook prompt merge
- bridge fallback / timeout / normalize

### Must Use Existing Libraries

- Rust 自带测试框架
- 前端现有测试基础如需补齐，可引入最小 Vitest 配置

### Must Be Self-Implemented

- host 集成测试夹具
- runtime event fixture

### Verification

- 新增测试能覆盖本计划中至少 5 条关键链路
- 后续 runtime 升级不再完全依赖手工点页面验证

## Workstream 7: 不建议当前投入的方向

这些方向不是永远不做，而是现在优先级不该排前面：

- 直接把 Tauri 宿主拆成大量 Cargo crates
- 优先补 CLI / JSON stream 新宿主模式
- 先做 VCR / HTTP replay 系统
- 先重做 Chat UI 视觉层
- 先重构插件或官网来配合 runtime 升级

原因：

- 它们对当前最核心的可维护性问题帮助有限
- 会稀释本次优化的主目标

## Recommended Execution Order

按依赖顺序，最优执行顺序如下：

1. Runtime Contract
2. ProviderCompat
3. Memory Subsystem
4. Approval Runtime
5. Context Bundle
6. Testing Matrix

原因：

- 没有统一 contract，approval 和 memory 很难真正稳定
- 没有 provider compat 升级，runtime 行为仍会受模型差异牵制
- memory 和 approval 都稳定后，context bundle 才能收得干净
- 测试要建立在相对稳定的模块边界上

## Success Criteria

完成本计划后，应达到以下结果：

1. `Chat`、`RedClaw`、`Settings`、`Workboard` 共享统一 runtime contract。
2. Provider 差异集中在 `provider_compat/*`，命令层不再散落处理。
3. Memory 成为独立子系统，而不是 `workspace_data` 的附属功能。
4. 高风险工具与脚本审批走统一 approval runtime。
5. Settings 可展示 context bundle / provider / approval / memory 的 diagnostics summary。
6. Host/runtime 核心链路拥有基本集成测试带。

## Verification

最终验收最少覆盖这组真实路径：

1. `Chat` 发起一次带工具调用的会话，验证 runtime event、approval、tool result 回流。
2. `Wander` 在 forced tool choice 条件下验证 provider compat 行为。
3. `RedClaw` 触发一个后台任务，验证 approval hold 与恢复。
4. `Settings` 查看 provider/profile/memory/context bundle/runtime diagnostics。
5. `memory:maintenance-run` 后重新进入 Chat，确认 memory recall 生效。

## Related Files

- [private/Docs/repository-functional-architecture.md](/Users/Jam/LocalDev/GitHub/RedConvert/private/Docs/repository-functional-architecture.md)
- [desktop/docs/rust-runtime-upgrade-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/rust-runtime-upgrade-plan.md)
- [desktop/docs/agent-collaboration-upgrade-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/agent-collaboration-upgrade-plan.md)
- [/Users/Jam/LocalDev/GitHub/aionrs/docs/repo-module-breakdown.md](/Users/Jam/LocalDev/GitHub/aionrs/docs/repo-module-breakdown.md)
