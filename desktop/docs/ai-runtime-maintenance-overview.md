# AI Runtime Maintenance Overview

更新时间：2026-04-16

这份文档不是产品介绍，也不是 roadmap。

它只回答维护阶段最重要的问题：

1. 现在 `RedBox` 的 AI 模块到底已经具备了哪些关键能力
2. 这些能力分别落在哪些代码边界
3. 出问题时应该先看哪里
4. 后续继续演进时，哪些约束不能被悄悄破坏

---

## 1. 总体结论

当前 `RedBox` 的 AI 模块，已经不是“一个会调模型和工具的聊天入口”。

它已经具备一套比较完整的 Agent Runtime 内核，核心性能体现在 7 个方面：

1. `Context` 已经结构化治理，而不是继续堆 prompt
2. `Memory / History / Recall` 已经拆层，不再混成一坨上下文
3. `Capability / Approval / Guard` 已经形成安全边界
4. `Subagent` 已经是带隔离策略的真实 child runtime
5. `Script Runtime` 已经能压缩机械多步任务，减少 token 污染
6. `Agent Job Runner` 已统一 scheduler / daemon / manual run
7. `Diagnostics / Checkpoints / Lineage` 已经足够支撑维护和回归定位

从维护角度看，这意味着：

- 主要风险已经不再是“功能做不出来”
- 主要风险变成“后续改动会不会破坏这些系统层边界”

---

## 2. 当前关键性能

### 2.1 Context 成本治理

当前运行时 prompt 已经从直接拼字符串升级为 `ContextBundle`。

关键性能：

- 固定 section 装配，避免上下文来源失控
- 每个 section 有 budget / truncate / scan
- 会把 context snapshot 持久化到 checkpoint
- diagnostics 能直接看 prompt 构成与压缩效果

关键文件：

- `src-tauri/src/interactive_runtime_shared.rs`
- `src-tauri/src/agent/context.rs`
- `src-tauri/src/agent/context_bundle.rs`
- `src-tauri/src/agent/context_scan.rs`
- `src-tauri/src/agent/context_budget.rs`

关键文档：

- `docs/runtime-context-bundle.md`

维护要求：

- 不要再把 profile doc、skill body、workspace rules 直接手拼回 system prompt
- 新上下文来源必须先过统一 scan / budget / snapshot
- 如果新增 runtime mode，要确认 diagnostics 能看到它的 context bundle summary

### 2.2 记忆与证据分层

当前长期信息已经拆成：

- `User Profile`
- `Workspace Facts`
- `Task Learnings`

同时保留：

- transcript
- checkpoints
- tool results

作为证据层。

关键性能：

- 历史是证据，memory 是结论
- recall 是按需工具，不是固定注入
- tool result 也能进入 recall 命中范围
- session lineage 已可追踪 fork / compact / resume

关键文件：

- `src-tauri/src/memory/mod.rs`
- `src-tauri/src/memory/types.rs`
- `src-tauri/src/memory/store.rs`
- `src-tauri/src/memory/maintenance.rs`
- `src-tauri/src/memory/recall.rs`

关键文档：

- `docs/runtime-memory-recall.md`

维护要求：

- 不要为了“效果更强”把大块历史重新塞回 system prompt
- 新 recall 能力必须带 output budget
- 如果新增 memory 类型，要同步维护 summary / diagnostics / maintenance

### 2.3 Capability 与审批边界

当前工具系统已经不是“只靠 tool pack 控制”，而是基于 `CapabilitySet`。

关键性能：

- 运行时会解析最终 capability set
- 有 `none / light / explicit / always_hold` 审批等级
- 高风险 profile doc、skill、MCP、runtime control 已进入 guard
- background / subagent 默认边界更严格
- 有 capability audit 记录

关键文件：

- `src-tauri/src/tools/capabilities.rs`
- `src-tauri/src/tools/guards.rs`
- `src-tauri/src/tools/catalog.rs`
- `src-tauri/src/main.rs`

关键文档：

- `docs/runtime-capability-guardrails.md`

维护要求：

- 不要新增绕过 guard 的宿主调用捷径
- 高风险工具默认先归到更严格审批，再按需求放开
- background 和 subagent 不应默认获得写 memory / profile / publish 一类能力

### 2.4 Child Runtime / Subagent

当前 subagent 已经是隔离的 child runtime，而不是 prompt 里伪装的“子角色”。

关键性能：

- parent / child 有独立 task、session、runtime lineage
- child context 继承是白名单式的
- child memory / approval / capability 有独立 policy
- parent 主要消费 summary / artifact / findings，不吞中间链路
- parent cancel 会递归传递给 child

关键文件：

- `src-tauri/src/subagents/spawner.rs`
- `src-tauri/src/subagents/policy.rs`
- `src-tauri/src/subagents/aggregation.rs`
- `src-tauri/src/subagents/types.rs`
- `src-tauri/src/runtime/orchestration_runtime.rs`

关键文档：

- `docs/runtime-child-runtime-v2.md`

维护要求：

- child 默认不要继承大块 transcript
- child 默认不要有高风险写权限
- 新 role 必须补 runtime type、policy 和 result contract
- 子任务 ID / session ID 必须保持唯一，不要退回到时间戳单独生成

### 2.5 Script Runtime

当前已经有一套受限程序化执行层，不再依赖外部 Python/Node 环境。

关键性能：

- 机械多步流程可压成脚本执行
- 中间工具结果不进入最终对话上下文
- 只暴露低风险读能力
- 有 timeout / tool-call / stdout / artifact / loop budget
- 已在 `knowledge / diagnostics / video-editor` 灰度启用

关键文件：

- `src-tauri/src/script_runtime/mod.rs`
- `src-tauri/src/script_runtime/limits.rs`
- `src-tauri/src/script_runtime/rpc.rs`
- `src-tauri/src/script_runtime/tool_bridge.rs`
- `src-tauri/src/commands/runtime_script.rs`

关键文档：

- `docs/runtime-script-execution-v1.md`

维护要求：

- 初版定位仍然是“受限数据处理器”，不是第二套 agent
- 默认不要新增写工具
- 如果新增脚本工具桥，要同步更新 limits、guard、diagnostics 和测试

### 2.6 Agent Job Runner

当前 scheduler、assistant daemon、manual runtime task 已统一进一个 job runner。

关键性能：

- 统一 enqueue / lease / heartbeat / retry / dead-letter
- 统一 `held` 状态
- 统一 delivery / retry / checkpoint / result policy
- background task 能看到 lineage、last checkpoint、last artifact

关键文件：

- `src-tauri/src/scheduler/job_runtime.rs`
- `src-tauri/src/scheduler/mod.rs`
- `src-tauri/src/assistant_core.rs`
- `src-tauri/src/commands/runtime_task_resume.rs`

关键文档：

- `docs/runtime-agent-job-v1.md`

维护要求：

- scheduler 不要直接重新去调模型
- manual task 和 daemon 新入口也应优先复用 `AgentJobRunner`
- 出现新长期运行入口时，先问是否应该变成新的 `sourceKind`

### 2.7 可观测性与维护定位

当前维护 AI 系统不再只靠日志。

关键性能：

- runtime debug summary 已集中展示关键状态
- `runtime.context_bundle` / `runtime.script_execution` / job execution 都有持久化记录
- Settings 能看 background tasks、runtime tasks、checkpoints、tool results、agent jobs
- session lineage 和 parent-child lineage 已可见

关键文件：

- `src-tauri/src/runtime/phase0.rs`
- `src/pages/Settings.tsx`
- `src/pages/settings/SettingsSections.tsx`
- `src/runtime/runtimeEventStream.ts`

维护要求：

- 新特性必须补 diagnostics 可见性，不要只写逻辑不留观测面
- 新的 checkpoint / audit / execution 类型要能在 UI 或 debug summary 找到

---

## 3. 当前 feature flag 基线

当前 AI runtime 关键开关：

- `runtimeContextBundleV2`
- `runtimeMemoryRecallV2`
- `runtimeSubagentRuntimeV2`
- `runtimeExecuteScriptV1`
- `runtimeAgentJobV1`

关键文件：

- `src-tauri/src/runtime/phase0.rs`
- `src/hooks/useFeatureFlags.ts`

维护要求：

- 新系统级能力应继续遵守同样模式：有开关、有 diagnostics、有 smoke、有 rollback

---

## 4. 维护时的优先排查顺序

### 4.1 模型输出变差 / prompt 爆涨

先看：

1. `runtime.context_bundle` checkpoint
2. `runtimeWarm.entries[*].contextBundleSummary`
3. `legacySystemPromptChars / charReductionRatio`

不要先猜模型变笨。

### 4.2 recall 失效 / 记忆污染

先看：

1. `memory/maintenance`
2. recall diagnostics
3. tool result / checkpoint 是否真的被写入

### 4.3 工具权限异常

先看：

1. `CapabilitySet`
2. capability audit records
3. `tools/guards.rs`

不要先在 UI 层 patch。

### 4.4 subagent 行为异常

先看：

1. child task / child session metadata
2. result contract
3. parent-child lineage
4. child capability policy

### 4.5 后台任务 / scheduler / daemon 异常

先看：

1. job definition
2. execution status
3. heartbeat / retry / held / dead-letter
4. last checkpoint / last artifact

不要跳过 job 层直接查具体业务逻辑。

---

## 5. 绝对不要破坏的系统约束

1. 不要重新回到“大 prompt 全注入”模式
2. 不要把长期 history 固定塞回 system prompt
3. 不要绕过 capability guard 直接调用高风险宿主能力
4. 不要把 subagent 退化成无边界 prompt 角色
5. 不要把 script runtime 扩成无约束通用 shell
6. 不要让 scheduler 或 daemon 再各自维护一套执行语义
7. 不要新增无 diagnostics、无 checkpoint、无 rollback 的 AI 能力
8. 不要使用仅毫秒时间戳生成全局实体 ID

---

## 6. 推荐维护动作

每次改 AI runtime，至少做这些验证：

- `cargo check`
- 相关专项测试
  - `context_`
  - `memory::`
  - `tools::capabilities::tests::`
  - `subagent_`
  - `script_runtime`
  - `scheduler::job_runtime::tests::`
- `pnpm build`
- 若 IPC 面变化，执行 `pnpm ipc:inventory`

如果改动跨多个系统层，至少手工检查一次 Settings 的 diagnostics：

- runtime warm
- latest context snapshots
- memory snapshot
- script runtime
- agent jobs
- background tasks

---

## 7. 配套文档索引

按主题查阅：

- Context：`docs/runtime-context-bundle.md`
- Memory / Recall：`docs/runtime-memory-recall.md`
- Capability / Guard：`docs/runtime-capability-guardrails.md`
- Child Runtime：`docs/runtime-child-runtime-v2.md`
- Script Runtime：`docs/runtime-script-execution-v1.md`
- Agent Jobs：`docs/runtime-agent-job-v1.md`
- 总体来源计划：`docs/hermes-agent-upgrade-roadmap.md`

如果后续继续升级 AI 系统，优先更新这份文档和对应专题文档，不要只在提交记录里留下信息。
