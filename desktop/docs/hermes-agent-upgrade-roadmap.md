# RedBox 吸收 Hermes Agent 经验的分阶段升级计划

更新时间：2026-04-15

## 1. 目标

这份计划不是把 `hermes-agent` 搬进 `RedBox`。

目标是吸收它真正有效的系统经验，把 `RedBox` 现有的：

- `runtime:event`
- `sessions / checkpoints / tool results`
- `skills`
- `MCP`
- `assistant daemon`
- `background tasks / scheduler`
- `subagents`

整理成一套更清晰、更低回归、更可持续演进的 Agent 基础设施。

本计划优先服务当前 `desktop/` Tauri + Rust 宿主，不扩展到旧 `archive/desktop-electron/`。

---

## 2. 核心判断

`hermes-agent` 值得借鉴的，不是“工具很多”或“入口很多”，而是这几件事：

1. 把 context / memory / skills / toolsets / subagents / automation 做成系统层，而不是零散 feature。
2. 把长期能力沉淀放在可治理边界里，而不是继续堆 prompt。
3. 把多入口统一到一个 runtime core，而不是每个入口各自拼 AI 行为。
4. 把安全、审批、恢复、可观察性都当一等公民。

对 `RedBox` 来说，最重要的是先补“系统层”，再补“平台层”。

---

## 3. 当前基础

`RedBox` 已经具备计划实施所需的大部分底座：

- 统一事件协议已初步存在，见 [src-tauri/src/events/mod.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/events/mod.rs:154)
- 工具 pack 已初步存在，见 [src-tauri/src/tools/packs.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/packs.rs:1)
- tool descriptor/schema 已初步存在，见 [src-tauri/src/tools/catalog.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/catalog.rs:16)
- skill runtime 裁剪逻辑已存在，见 [src-tauri/src/skills/runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/skills/runtime.rs:71)
- prompt 装配入口已存在，见 [src-tauri/src/interactive_runtime_shared.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/interactive_runtime_shared.rs:18)
- real subagent 基础骨架已存在，见 [src-tauri/src/subagents/spawner.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/subagents/spawner.rs:94)

所以这份计划的重点不是“补齐空白功能”，而是“把已有零件收束成稳定内核”。

---

## 4. 升级原则

1. 先统一内核，再扩入口。
2. 先控制上下文成本，再增加记忆与自动化。
3. 先强边界，再放开能力。
4. 所有阶段都必须可灰度、可回滚、可验证。
5. 不引入“每轮固定大注入”的重 prompt 负担。
6. 不新增依赖于消息平台的强耦合方案，优先桌面端、daemon、scheduler 统一。

---

## 5. 总体分期

建议分成 7 个阶段，按价值和依赖关系推进：

1. Phase 0：基线与治理准备
2. Phase 1：Context Assembly 与 Prompt 成本治理
3. Phase 2：记忆、历史、检索三层拆分
4. Phase 3：Capability Set、审批与安全边界
5. Phase 4：真实 Child Runtime 与 Subagent 升级
6. Phase 5：程序化执行层与机械任务压缩
7. Phase 6：统一 Agent Job / Scheduler / Daemon Runtime

建议顺序不要反。

尤其不要在 Phase 1-3 之前先重做 scheduler 或大规模扩消息入口。

---

## 6. Phase 0：基线与治理准备

### 目标

先把后续升级所需的指标、开关、观测和兼容面准备好，避免进入“边改边猜”的状态。

### 为什么先做

后面每个阶段都会动 runtime 行为。

如果没有基线，就无法判断：

- prompt 是否变短
- tool 调用是否变稳
- session 恢复是否更可靠
- scheduler 是否更少丢任务

### 具体工作

1. 建立运行时基线指标

- 单轮 system prompt chars / estimated tokens
- active skills 数量
- available tools 数量
- 平均 tool call 次数
- checkpoint 数量
- trace 长度
- session 恢复成功率

2. 建立功能开关

- `runtime.context_bundle_v2`
- `runtime.memory_recall_v2`
- `runtime.subagent_runtime_v2`
- `runtime.execute_script_v1`
- `runtime.agent_job_v1`

3. 对关键链路补 smoke

- `runtime:query`
- `tasks:create`
- `runtime:get-checkpoints`
- `sessions:get-transcript`
- `background-tasks:list`
- `session-bridge:*`

4. 建立升级验收面板

- Settings 里的 diagnostics 区补一个 runtime debug summary
- 显示当前 prompt 构成、tool pack、skills、memory snapshot 概览

### 涉及文件

- [src-tauri/src/events/mod.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/events/mod.rs:154)
- [src/bridge/ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/ipcRenderer.ts:15)
- [src/pages/Settings.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Settings.tsx:1526)

### 验收标准

- 能看到当前会话的 prompt 大小、active skills、tool pack、checkpoints 数
- 所有新特性都可按开关关闭
- 关键 IPC smoke 可手工验证

### 预计周期

3-5 天

---

## 7. Phase 1：Context Assembly 与 Prompt 成本治理

### 目标

把当前“大模板 + 直接拼 profile/skills/context”的 prompt 生成方式，升级为结构化 Context Assembly。

### 这是最优先阶段

因为 Hermes 的最大优点之一是上下文层次清晰，而它社区当前最大问题之一也是 token bloat。

`RedBox` 应该吸收前者，规避后者。

### 当前问题

当前 [interactive_runtime_shared.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/interactive_runtime_shared.rs:18) 已经开始做 runtime prompt 装配，但还有这些问题：

- context source 没有统一抽象
- RedClaw profile docs 直接拼进 prompt
- skill/context/profile/tool note 边界不够清晰
- 没有统一 injection scan
- 没有统一 truncation / source attribution / snapshot 持久化

### 目标结构

引入 `ContextBundle`：

- `identity_section`
- `workspace_rules_section`
- `runtime_mode_section`
- `skill_overlay_section`
- `memory_summary_section`
- `profile_docs_section`
- `tool_contract_section`
- `ephemeral_turn_section`

每个 section 具备：

- source
- priority
- char budget
- truncation strategy
- scan result

### 具体工作

1. 新增 context 模块

建议新增：

- `src-tauri/src/agent/context.rs`
- `src-tauri/src/agent/context_bundle.rs`
- `src-tauri/src/agent/context_scan.rs`
- `src-tauri/src/agent/context_budget.rs`

2. 从 `interactive_runtime_system_prompt()` 中拆分数据源读取与文本渲染

当前函数保留“编排入口”，不再直接承载所有规则。

3. 引入上下文扫描

扫描对象：

- `Agent.md / Soul.md / user.md / CreatorProfile.md`
- workspace 规则文档
- skills body
- 外部注入的 context 文本

扫描内容：

- prompt override
- hidden instruction
- secret exfiltration pattern
- invisible unicode

4. 引入 budget 策略

建议初版预算：

- identity：2k chars
- workspace rules：3k chars
- memory summary：2k chars
- profile docs：6k chars
- skills overlay：3k chars
- tool contract：2k chars

5. 记录每轮上下文快照

至少持久化：

- session_id
- runtime_mode
- active sections
- total chars
- truncated sections
- scan warnings

### 涉及文件

- [src-tauri/src/interactive_runtime_shared.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/interactive_runtime_shared.rs:43)
- [src-tauri/src/skills/runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/skills/runtime.rs:71)

### 验收标准

- prompt 装配从“直接拼串”升级为 section-based bundle
- 能在 diagnostics 看见每轮 context source 和 budget
- RedClaw/profile/skill 注入都经过统一 scan + truncate
- 默认 prompt 长度比当前基线下降 20%-35%

### 风险

- 如果一开始做得太“可配置”，会拖慢进度
- 初版必须优先固定策略，不要先做复杂 UI 编辑器

### 预计周期

1.5-2 周

---

## 8. Phase 2：记忆、历史、检索三层拆分

### 目标

把“memory”和“session history”彻底拆成不同层级，不再混用。

### 设计原则

- 历史是证据
- 记忆是结论
- recall 是工具，不是固定注入

### 当前问题

仓库里已有：

- `memory:*`
- `sessions:*`
- `runtime:get-checkpoints`
- `runtime:get-tool-results`

但缺少一个统一的 recall contract。

### 目标结构

建议拆成三层：

1. `User Profile`

- 用户稳定偏好
- 长期合作方式
- 输出风格与沟通偏好

2. `Workspace Facts`

- 工作区路径、约束、常用流程
- 项目稳定事实
- 外部依赖与环境边界

3. `Task Learnings`

- 某类任务可复用的经验结论
- 不等于完整 transcript

另保留：

- transcript
- checkpoints
- tool results

作为检索证据层。

### 具体工作

1. 统一 memory 数据模型

建议新增：

- `src-tauri/src/memory/types.rs`
- `src-tauri/src/memory/store.rs`
- `src-tauri/src/memory/maintenance.rs`
- `src-tauri/src/memory/recall.rs`

2. 引入 Recall API

统一由 `redbox_runtime_control` 或单独 recall tool 暴露：

- recall user facts
- recall workspace facts
- search sessions
- search checkpoints
- search tool results

3. 把 tool result 纳入检索索引

很多高价值知识不在对话文本里，而在工具输出里。

4. 增加 lineage

- session fork
- compacted session parent
- resumed from checkpoint

5. 增加 memory maintenance 策略

- 去重
- 压缩
- 降级过期任务学习
- 防止每轮注入越来越重

### 涉及文件

- [src-tauri/src/commands/workspace_data.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/workspace_data.rs:398)
- [src/bridge/ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/ipcRenderer.ts:193)

### 验收标准

- memory 结构化为至少 3 类
- session/tool result/checkpoint 可统一 recall
- 默认 system prompt 不再固定注入大块历史
- 能从 UI 或 diagnostics 验证 lineage / recall 命中来源

### 风险

- 如果 recall 结果过长，会把 token bloat 从 prompt 阶段转移到 tool output 阶段
- 初版必须控制 output budget

### 预计周期

2 周

---

## 9. Phase 3：Capability Set、审批与安全边界

### 目标

把现在“tool pack + skill allowedTools”的基础，升级为完整 Capability Set 和 Guard 层。

### 当前基础

你们已经有：

- tool packs：[src-tauri/src/tools/packs.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/packs.rs:25)
- tool descriptors：[src-tauri/src/tools/catalog.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/catalog.rs:16)
- skill 权限裁剪：[src-tauri/src/skills/runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/skills/runtime.rs:79)

但现在还不够：

- `requires_approval` 基本都还是 `false`
- 缺少参数级 guard
- 缺少入口级 capability policy
- 缺少 memory / publish / mcp side-effect 边界

### 目标结构

每次运行生成一个 `CapabilitySet`：

- runtime_mode
- entry_kind
- active_skills
- allowed_tools
- blocked_tools
- approval_policy
- write_scope
- network_scope
- mcp_scope
- memory_write_policy

### 具体工作

1. 引入 CapabilitySet 解析器

来源：

- runtime_mode 默认 pack
- session metadata
- skill overlays
- entry kind
- subagent overrides

2. 引入审批等级

建议最少四档：

- `none`
- `light`
- `explicit`
- `always_hold`

3. 把高风险能力纳入 guard

尤其是：

- profile doc update
- publish/draft/send
- shell/process 类能力
- sidecar / daemon 控制
- MCP write / credential-touching actions

4. 增加参数级校验

例如：

- path 是否越界
- action 是否允许
- MCP server 是否白名单
- profile docs 是否允许在当前 runtime 修改

5. 审计记录

至少记录：

- who / runtime / entry
- approved what
- arguments summary
- timestamp

### 涉及文件

- [src-tauri/src/tools/catalog.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/catalog.rs:27)
- [src-tauri/src/commands/chat.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/chat.rs:121)
- [src/bridge/ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/ipcRenderer.ts:276)

### 验收标准

- 每轮执行能导出最终 CapabilitySet
- 至少 3 类高风险工具进入审批路径
- subagent 默认无 shared memory 写权限
- 后台任务默认无高风险写工具

### 预计周期

1.5 周

---

## 10. Phase 4：真实 Child Runtime 与 Subagent 升级

### 目标

把已有 subagent 从“能跑 child turn”升级为真正隔离的 child runtime。

### 当前基础

现在 [subagents/spawner.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/subagents/spawner.rs:108) 已经做了这些事：

- child task / session
- allowedTools 注入
- parent/child runtime id
- subagent started/finished event

这比纯 prompt 模拟已经前进很多。

### 还缺什么

1. child context 继承规则
2. child memory policy
3. child model override
4. token 与 budget 控制
5. parent 只看 summary/artifact，而不吞掉完整子链路
6. 失败恢复与中断传播标准化

### 具体工作

1. 完善 `SubAgentConfig`

增加：

- `context_policy`
- `memory_policy`
- `approval_policy`
- `model_override`
- `budget`
- `result_contract`

2. 区分 child runtime 类型

- researcher
- reviewer
- fixer
- editor-planner
- publisher-safe

3. 引入结果契约

输出结构至少包括：

- summary
- artifact refs
- findings
- risks
- handoff
- approvals requested

4. 强化事件链路

在 `runtime:event` 上带出：

- parent_runtime_id
- child_runtime_id
- phase
- status
- result_summary

5. 限制默认继承

默认不要继承：

- 大块 transcript
- memory write 权限
- publish 权限
- 高风险 MCP 权限

### 涉及文件

- [src-tauri/src/subagents/spawner.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/subagents/spawner.rs:182)
- [src-tauri/src/events/mod.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/events/mod.rs:164)
- [src/runtime/runtimeEventStream.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/runtime/runtimeEventStream.ts:258)

### 验收标准

- parent context 不再包含 child 中间工具明细
- child runtime 可按 role 切 model/capability
- 中断 parent 时 child 能一致中断
- diagnostics 可查看 parent-child lineage

### 预计周期

2 周

---

## 11. Phase 5：程序化执行层与机械任务压缩

### 目标

为 `RedBox` 增加一个类似 Hermes `execute_code` 的“受限程序化执行层”，把机械流程从多轮 LLM 工具调用压缩成单次脚本执行。

### 为什么值得做

Hermes 在这块的价值非常明确：

- 把机械多步处理压成一次执行
- 只有最终 stdout 回到上下文
- 中间工具结果不污染 prompt

这对 `RedBox` 很适合，尤其是：

- 批量内容处理
- 素材清洗
- 知识导入转换
- 多文件分析
- 编辑器批量修正

### 设计边界

不要一开始就做通用 shell 沙箱。

建议初版做“受限脚本 + 受限 RPC 工具”：

- 运行语言：Python 或 JS 二选一
- 允许工具：只开放只读或低风险工具
- 输出：仅 stdout + artifacts

### 具体工作

1. 新增 `scripted_execution` 模块

建议：

- `src-tauri/src/script_runtime/mod.rs`
- `src-tauri/src/script_runtime/rpc.rs`
- `src-tauri/src/script_runtime/limits.rs`
- `src-tauri/src/script_runtime/tool_bridge.rs`

2. 初版只开放这些工具

- app query
- fs read/list
- search
- selected editor read ops
- selected MCP read ops

3. 增加资源限制

- timeout
- max stdout
- max tool calls
- temp workspace

4. 输出模型

- `stdout`
- `artifact_paths`
- `tool_call_count`
- `error_summary`

5. 在特定 runtime mode 灰度

- knowledge
- diagnostics
- video-editor analysis

先不要在 publish / redclaw automation 默认启用。

### 验收标准

- 至少 3 个多步机械任务可由 script runtime 完成
- token 使用明显下降
- 中间工具结果不进入最终对话上下文
- 有 timeout 和 budget 保护

### 风险

- 如果一开始暴露写工具过多，会把安全边界打穿
- 初版必须更像“受限数据处理器”，而不是“第二套 agent”

### 预计周期

2-3 周

---

## 12. Phase 6：统一 Agent Job / Scheduler / Daemon Runtime

### 目标

让 scheduler、background task、assistant daemon 都跑统一的 Agent Job，而不是各自有一套执行语义。

### 这是中后期最关键阶段

因为到这一步，`RedBox` 才真正从“带 AI 的桌面应用”升级成“可长期运行的 agent 系统”。

### 当前问题

你们已有：

- `background-tasks:*`
- `tasks:*`
- assistant daemon
- RedClaw scheduler / long-cycle task

但还没有统一成一个标准 job model。

### 目标结构

引入 `AgentJob`：

- job_id
- source_kind
- schedule / trigger
- runtime_mode
- prompt_or_task_ref
- attached_skills
- capability_set
- delivery_policy
- retry_policy
- checkpoint_policy
- result_policy

### 具体工作

1. scheduler 不直接调模型

它只负责：

- enqueue
- lease
- heartbeat
- retry
- dead-letter

真正执行由统一 `AgentJobRunner` 完成。

2. daemon / scheduler / manual run 共用一个 Job Runner

输入来源不同，执行内核相同。

3. fresh session 语义标准化

每次 job 都有：

- context bundle snapshot
- attached skills
- capability set
- result contract

4. delivery policy 标准化

- write local artifact
- update workspace state
- append task record
- UI notification
- optional external delivery

5. 增加恢复语义

- retry from start
- retry from checkpoint
- hold for approval
- dead letter with last artifact

### 涉及文件

- [src-tauri/src/scheduler/mod.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/scheduler/mod.rs:255)
- [src-tauri/src/scheduler/job_runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/scheduler/job_runtime.rs:235)
- [src-tauri/src/assistant_core.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/assistant_core.rs:554)
- [src-tauri/src/commands/bridge.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/bridge.rs:80)

### 验收标准

- scheduler / daemon / manual task 三条路径使用同一个 AgentJobRunner
- background task 有一致状态机
- 失败可重试、可挂起、可恢复
- 可在 diagnostics 中看到 job lineage、最后 checkpoint、最后 artifact

### 预计周期

3-4 周

---

## 13. 每阶段共同要求

每个 phase 都必须满足这些要求：

1. 有 feature flag
2. 有 smoke 路径
3. 有 rollback 路径
4. 有 diagnostics 可见性
5. 不破坏现有 `runtime:event` 兼容面

---

## 14. 推荐实施顺序与节奏

如果按一个 6-10 周的节奏推进，建议这样拆：

### Wave A：先做系统内核

- Phase 0
- Phase 1
- Phase 2

目标：

- 把 context / memory / recall 做干净
- 先降低 token 成本和 prompt 污染

### Wave B：再做执行边界

- Phase 3
- Phase 4

目标：

- 把 capability / approval / subagent 做扎实
- 让复杂任务可以安全并行

### Wave C：最后做长期运行

- Phase 5
- Phase 6

目标：

- 把机械任务压缩
- 把 scheduler / daemon / background 跑成统一 job runtime

---

## 15. 建议优先级

### P0：立刻开工

- Phase 0
- Phase 1

这是最该马上做的。

### P1：下一阶段

- Phase 2
- Phase 3

这决定系统是否能长期稳定扩展。

### P2：中期升级

- Phase 4
- Phase 5
- Phase 6

这会真正拉开与普通桌面 AI 产品的差距。

---

## 16. 不建议现在做的事

1. 不先扩大量消息平台入口

当前更应该统一桌面端 + daemon + scheduler。

2. 不先把技能做成更复杂的 market UI

先把 skill runtime contract 做扎实。

3. 不先引入大而全的 shell agent

先做受限程序化执行层。

4. 不先重写全部前端页面

先让 runtime 协议稳定，再调整 UI。

---

## 17. 里程碑定义

### M1：Context Bundle 上线

- prompt 结构化装配
- 注入扫描
- context budget
- diagnostics 可见

### M2：Recall 系统上线上

- memory / history / tool result 分层
- 统一 recall 接口
- lineage 可见

### M3：Capability Guard 上线

- capability set
- tool approval
- high-risk guard

### M4：真实 Child Runtime 上线

- parent-child lineage
- model override
- child result contract

### M5：Script Runtime 上线

- 机械多步任务压缩
- stdout-only context return
- budget/timeout 生效

### M6：Agent Job 上线

- scheduler / daemon / background 统一执行
- retry / hold / dead-letter / checkpoint resume

---

## 18. 推荐第一批 issue 列表

如果要开始拆任务，建议第一批 issue 只开这 8 个：

1. `ContextBundle` 类型与装配器落地
2. context scan 与 truncation 策略落地
3. runtime diagnostics 增加 prompt/capability/memory summary 面板
4. memory types 重构为三层模型
5. recall API 统一 transcript/checkpoint/tool result 查询
6. `CapabilitySet` 类型与解析器落地
7. 高风险工具审批路径接到 `chat:confirm-tool`
8. subagent config 扩展为 context/memory/approval/model policy

---

## 19. 最终效果预期

完成这轮升级后，`RedBox` 应该达到的不是“更像 Hermes”，而是更清晰地成为：

- 一个有结构化 context engine 的桌面 Agent
- 一个有边界长期记忆与跨会话 recall 的工作区助手
- 一个可以安全并行 child runtime 的复杂任务系统
- 一个能让 daemon / scheduler / background 统一跑起来的本地 Agent 平台

如果只能用一句话概括这份 roadmap：

先把 `RedBox` 从“功能很多的 AI 桌面应用”升级成“有内核分层的 Agent Runtime”，再谈更大的自动化与平台扩展。
