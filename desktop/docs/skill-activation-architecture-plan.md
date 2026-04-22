---
doc_type: plan
execution_status: completed
last_updated: 2026-04-21
execution_stage: runtime_continuation_and_ui_guard_completed
owner: codex
target_files:
  - src-tauri/src/skills/prompt.rs
  - src-tauri/src/skills/executor.rs
  - src-tauri/src/skills/runtime.rs
  - src-tauri/src/commands/skills_ai.rs
  - src-tauri/src/main.rs
  - src/components/MessageItem.tsx
success_metrics:
  - skills invoke 不再把 XML 风格激活包回流到模型上下文
  - interactive runtime 在技能激活后自动按新上下文续跑
  - prompt 明确区分“已激活技能”和“可见但未激活技能”
  - UI 不再直接暴露内部协议标签
---

# LexBox Skill Activation Architecture Plan

## Goal

这份方案把 `LexBox` 当前的技能系统从“消息时机驱动 + metadata 拼装驱动”重构成“目录发现、激活决策、提示词注入、执行回流”四层分离架构。

目标不是修一个 `writing-style` 的个案，而是一次性解决以下结构性问题：

1. 技能激活依赖前端某次消息是否恰好带对 `taskHints.activeSkills`。
2. 新会话首条消息的技能请求不能稳定持久化到 session。
3. prompt 组装层自己推断激活状态，职责混乱。
4. builtin skill、本地 skill、显式 invoke skill 的来源和生命周期不统一。
5. Windows 与 macOS 在路径、换行、skill bundle 解析上容易出现不一致。

最终目标：

- 技能发现是独立子系统。
- 技能激活是独立状态机。
- prompt 注入只消费激活快照。
- skill 执行拥有统一入口，并能把上下文修饰安全回流到运行时。

## Execution Update

截至 2026-04-21，以下基础重构已经落地：

- `Skill Catalog` 基础层已拆出，builtin registry 不再散落在 persistence 内。
- session 里的技能状态已升级为 typed `sessionSkillState`，业务层不再直接操纵裸 `metadata.activeSkills`。
- `Skill Activation Engine` 与 `Prompt Assembly` 已分离，system prompt 入口改为消费 `ResolvedSkillSet` 和 `SkillPromptBundle`。
- 显式 `skills invoke` 已下沉到独立 `executor`，命令层仅做路由、日志和响应包装。

截至 2026-04-21，这一轮围绕“技能激活后标签泄漏与自动停止”的运行时优化已经完成：

- `skills:invoke` 只返回结构化激活过渡信息，不再把 `<activated_skill>` bundle 当 tool result 回流。
- Anthropic / Gemini / OpenAI 三条 interactive runtime 都改成“每轮请求前重建 provider payload”，技能激活后下一轮会自动拿到新的 system prompt。
- runtime 在检测到技能激活后，会自动追加内部 continuation 指令，要求模型不要复述激活过程、不要输出协议标签、直接继续当前任务。
- prompt catalog 文案已改成显式区分“已激活技能”和“未激活技能”，避免同轮上下文自相矛盾。
- 聊天 UI 在 thought / assistant 内容渲染前增加了协议文本兜底过滤。

本轮不涉及的范围：

- `conditional.rs` 的条件命中体系
- `discovery.rs` 的进一步目录发现清理
- legacy `activeSkills` shadow 的最终移除

## Executed Architecture

### AI / Runtime

- `src-tauri/src/commands/skills_ai.rs`
  只输出结构化 `activationTransition`，这是运行时状态切换信号，必须自研，不能交给 Markdown/提示词约定兜底。
- `src-tauri/src/main.rs`
  interactive runtime 现在维护两份消息视图：
  - `prompt_messages`：给模型的短窗口 prompt history
  - `canonical_messages`：用于持久化与恢复的完整运行时消息
- 每轮请求前都重新计算：
  - 最新 system prompt
  - 最新 provider message/contents
  - 最新 tool schema
- 技能激活成功后，runtime 会自动插入 continuation 指令。这个状态机必须自研，因为它同时依赖 session metadata、provider payload 组装和工具轮次控制。

### UI

- `src/components/MessageItem.tsx`
  在 Markdown 渲染前过滤 `<tool_call>...</tool_call>` 和 `<activated_skill>...</activated_skill>`。
- 这部分继续复用现有 `ReactMarkdown`，不需要新增库；过滤逻辑保持在渲染层本地实现即可。

### Video / Media

- 本次不改视频处理或媒体生成引擎。
- 视频相关 skill 仍通过现有 `app_cli(command=\"video ...\")` 与既有媒体链路执行。
- 也就是说：本次优化只修“技能激活如何影响 AI 运行时”，不触碰 ffmpeg、媒体探测、素材生成或编辑器协议。

## Build Vs Buy

- 必须自研：
  - skill activation transition 协议
  - interactive runtime continuation 机制
  - provider payload 按轮重建逻辑
  - UI 内部协议过滤策略
- 继续使用现成库：
  - Markdown 渲染：`react-markdown` + `remark-gfm`
  - HTTP / SSE 请求：现有 host runtime 与 `curl` 执行链
  - session persistence / tool registry：现有仓内模块

## Performance Strategy

- 每轮重建 provider payload 只基于内存中的 `prompt_messages`，不重新扫描工作区，不引入额外 I/O。
- skill activation 检测只解析小型 JSON tool result，不做正则式全文扫描。
- UI 过滤只在单条消息渲染时做固定模式替换，复杂度线性且输入规模很小。
- `canonical_messages` 继续承担完整恢复，`prompt_messages` 继续承担短窗口推理，避免“每轮把整段历史重新喂给模型”的 token 膨胀。

## Why Current Architecture Fails

当前实现的问题不在单个 bug，而在边界设计。

### 1. 激活入口和会话创建时序耦合

当前 `chat:send-message` 会先尝试从 payload 提取 `taskHints.activeSkills`，然后只在 session 已存在时才把它们写入 metadata：

- [src-tauri/src/commands/chat.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/chat.rs:41)
- [src-tauri/src/commands/chat.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/chat.rs:163)

但真正的 session 创建发生在后面的 exchange persistence：

- [src-tauri/src/agent/session.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/agent/session.rs:17)
- [src-tauri/src/commands/chat_state.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/chat_state.rs:104)

这导致“新会话首条消息请求 session 级技能”天然不可靠。

### 2. 技能激活和 prompt 注入混在同一层

当前 `build_skill_runtime_state(...)` 同时承担：

- catalog 加载
- active skill 选择
- tool allowlist 收缩
- prompt prefix/suffix/context note 拼装
- skills section 拼装

核心入口：

- [src-tauri/src/skills/runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/skills/runtime.rs:277)
- [src-tauri/src/interactive_runtime_shared.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/interactive_runtime_shared.rs:22)

结果是任何一个激活时序问题，都会直接表现成“技能没注入”。

### 3. builtin skill 与目录 skill 没有统一 catalog

`writing-style` 当前直接作为 builtin record 嵌在 store 初始化逻辑里：

- [src-tauri/src/persistence/mod.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/persistence/mod.rs:489)

这会造成：

- builtin 来源与工作区 skill 来源不同构
- catalog 指纹、热更新、来源优先级难以统一
- prompt 注入和显式 invoke 的行为容易分叉

### 4. session metadata 成了隐式技能总线

当前大量逻辑围绕 `metadata.activeSkills` 做隐式通信：

- chat send merge
- wander session bootstrap
- skills invoke merge
- runtime prompt 读取
- tool registry 读取

这会让业务入口和运行时强耦合，也不利于做跨平台一致性验证。

## Aionrs Comparison

`aionrs` 的关键优点不是某个函数，而是分层清楚：

### Aionrs 的发现层

- [aion-skills loader](</Users/Jam/LocalDev/GitHub/aionrs/crates/aion-skills/src/loader.rs:28>)
- 统一加载 bundled、user、project、legacy、MCP skill
- 去重和优先级独立完成

### Aionrs 的条件激活层

- [conditional manager](</Users/Jam/LocalDev/GitHub/aionrs/crates/aion-skills/src/conditional.rs:27>)
- skill 先进入 dormant，再按路径命中激活
- 路径统一规范化成 forward slash

### Aionrs 的 prompt 层

- [system prompt builder](</Users/Jam/LocalDev/GitHub/aionrs/crates/aion-agent/src/context.rs:84>)
- 只注入“可见技能列表”
- 不把会话状态和技能执行状态耦合在一起

### Aionrs 的执行层

- [skill tool](</Users/Jam/LocalDev/GitHub/aionrs/crates/aion-agent/src/skill_tool.rs:181>)
- skill 执行上下文、hooks、权限、fork/inline 都由执行层控制

### LexBox 与 Aionrs 的差异

LexBox 不能照抄 `aionrs` 的纯显式 Skill Tool 模式，因为 LexBox 是产品工作流 agent，而不是通用 CLI agent。LexBox 必须支持：

- route policy 自动激活
- editor / wander / redclaw 默认技能
- session 级持续生效
- 显式 invoke 与自动激活共存
- prompt 注入与 host runtime mode 紧密配合

所以最优解不是复制 `aionrs`，而是吸收它的分层方式。

## Target Architecture

LexBox 的目标技能系统采用四层结构：

1. `Skill Catalog`
2. `Skill Activation Engine`
3. `Prompt Assembly`
4. `Skill Execution`

调用顺序：

1. catalog 加载所有技能元数据
2. 各入口只提交 `SkillActivationIntent`
3. activation engine 归并成 `SessionSkillState`
4. runtime 将 `SessionSkillState + RuntimeContext` 解析成 `ResolvedSkillSet`
5. prompt assembly 只消费 `ResolvedSkillSet`
6. explicit invoke / hook / tool permission 通过 executor 回流 activation state

## Architecture Modules

### 1. Skill Catalog

新增模块：

- `src-tauri/src/skills/catalog.rs`
- `src-tauri/src/skills/discovery.rs`
- `src-tauri/src/skills/bundled.rs`

职责：

- 统一加载 builtin、workspace、user skill
- 统一解析 frontmatter 与 bundle sections
- 统一名称去重和来源优先级
- 生成 `catalog_fingerprint`
- 提供 watcher snapshot

数据结构：

```rust
pub enum SkillSource {
    Builtin,
    Workspace,
    User,
}

pub struct SkillCatalogEntry {
    pub id: String,
    pub name: String,
    pub source: SkillSource,
    pub is_builtin: bool,
    pub logical_path: String,
    pub metadata: SkillMetadataRecord,
    pub description: String,
    pub body: String,
    pub references: BTreeMap<String, String>,
    pub rules: BTreeMap<String, String>,
    pub scripts: BTreeMap<String, String>,
    pub fingerprint: String,
}
```

来源优先级：

1. Builtin
2. Workspace
3. User

规则：

- builtin skill 不能再直接散落在 `default_store()` 和 `ensure_builtin_skills_present()` 里
- 所有 skill，无论 builtin 还是目录发现，最后都必须进入同一份 `SkillCatalogEntry`
- 统一保留 `logical_path`，不再把真实文件路径直接暴露为业务主键

### 2. Skill Activation Engine

新增模块：

- `src-tauri/src/skills/activation.rs`
- `src-tauri/src/skills/state.rs`
- `src-tauri/src/skills/conditional.rs`

职责：

- 把不同来源的激活请求统一成 typed intent
- 处理 session scope / turn scope
- 处理 runtime mode 兼容性
- 处理 conditional skill 的路径命中
- 产出 session 内唯一可信的技能状态

核心数据结构：

```rust
pub enum SkillActivationSource {
    Explicit,
    RoutePolicy,
    TaskHints,
    Conditional,
    SessionRestore,
    ContextDefault,
}

pub struct SkillActivationIntent {
    pub skill_name: String,
    pub source: SkillActivationSource,
    pub requested_scope: Option<String>,
    pub reason: String,
}

pub struct SessionSkillState {
    pub requested: Vec<SessionSkillRecord>,
    pub active: Vec<SessionSkillRecord>,
    pub rejected: Vec<RejectedSkillRecord>,
    pub updated_at: String,
}

pub struct ResolvedSkillSet {
    pub active_skills: Vec<SkillCatalogEntry>,
    pub visible_skills: Vec<SkillCatalogEntry>,
    pub allowed_tools: Vec<String>,
    pub prompt_hooks: SkillPromptHooks,
    pub fingerprint: String,
}
```

`SessionSkillRecord` 至少包含：

- `name`
- `scope`
- `source`
- `runtime_modes`
- `reason`
- `persisted`

### 3. Prompt Assembly

新增模块：

- `src-tauri/src/skills/prompt.rs`
- `src-tauri/src/runtime/system_prompt.rs`

职责：

- 将 `ResolvedSkillSet` 渲染成 prompt 可消费结构
- 处理目录摘要和激活正文的预算
- 保证 prompt 注入不再自己推断激活状态

输出结构：

```rust
pub struct SkillPromptBundle {
    pub catalog_section: String,
    pub active_section: String,
    pub prompt_prefix: String,
    pub prompt_suffix: String,
    pub context_note: String,
    pub fingerprint: String,
}
```

规则：

- visible skills 只进入目录摘要，不进入完整正文
- active skills 才进入正文注入
- `prompt_prefix` / `prompt_suffix` / `context_note` 只从 active skills 归并
- 不再从 session metadata 直接拼出 skills section

### 4. Skill Execution

新增模块：

- `src-tauri/src/skills/executor.rs`
- `src-tauri/src/skills/hooks.rs`

职责：

- 显式技能调用
- inline / fork 执行上下文
- tool allowlist / blocked tools 收敛
- 执行后把 hooks、context modifiers、scope 结果回写 activation engine

规则：

- 所有 `skills:invoke` 都必须走 executor
- 不允许 `skills_ai.rs` 自己直接拼 session metadata
- turn scoped skill 的生命周期只能由 executor 控制

## Runtime Data Flow

### A. Chat Send

旧流程：

1. payload 里带 `taskHints.activeSkills`
2. 若 session 已存在则 merge metadata
3. runtime 再读 metadata.activeSkills

新流程：

1. `chat:send-message`
2. `ensure_session`
3. `build_activation_intents_from_task_hints`
4. `reduce_session_skill_state`
5. `resolve_runtime_mode`
6. `build_resolved_skill_set`
7. `build_skill_prompt_bundle`
8. `run interactive runtime`

### B. Wander

旧流程：

- wander session metadata 直接写 `activeSkills: ["writing-style"]`

新流程：

1. wander 创建 session
2. wander route policy 生成 `SkillActivationIntent { source: RoutePolicy }`
3. activation engine 归并状态
4. prompt assembly 注入写作风格

### C. Explicit Skill Invoke

旧流程：

- `skills:invoke` 直接 merge `metadata.activeSkills`

新流程：

1. `skills:invoke`
2. executor 校验 skill、scope、runtime mode、permissions
3. activation engine 写入 `turn` 或 `session` 激活结果
4. executor 返回 rendered bundle / fork execution result
5. runtime 读取新的 `ResolvedSkillSet`

## Frontend Contract

前端协议必须从“传最终 activeSkills”改成“传激活意图”。

### 旧协议

```ts
taskHints: {
  intent: 'manuscript_creation',
  activeSkills: ['writing-style'],
}
```

### 新协议

```ts
taskHints: {
  taskIntent: 'manuscript_creation',
  workspaceMode: 'redclaw-authoring',
  targetKind: 'richpost',
  requestedSkills: ['writing-style'],
}
```

说明：

- 前端可以建议 `requestedSkills`
- 前端不能再定义最终 `activeSkills`
- 是否激活、激活到哪一级、是否被拒绝，全由 host 决定

## Persistence Contract

旧的 `metadata.activeSkills` 不再作为主存储结构。

新增 session metadata 字段：

```json
{
  "sessionSkillState": {
    "requested": [],
    "active": [],
    "rejected": [],
    "updatedAt": "..."
  }
}
```

迁移规则：

1. 读取老 session 时，如果发现 `metadata.activeSkills`
2. 转换成 `sessionSkillState.requested`
3. 通过 activation engine 重算 active/rejected
4. 持久化时只写 `sessionSkillState`

兼容期内：

- 可读 `activeSkills`
- 禁止新代码继续写 `activeSkills`

## Cross-Platform Compatibility Rules

这次重构必须把路径和文本规范化变成底层能力，而不是零散补丁。

### 统一路径规则

- 使用 `camino::Utf8PathBuf` 作为 catalog/discovery 层的主路径类型
- 所有逻辑路径统一转成 forward slash
- `conditional.rs` 的路径匹配统一使用 slash 风格
- 文件系统落盘仍然使用 `PathBuf`

### 统一文本规则

- 读取 skill body / references / rules / scripts 前统一做换行规范化
- frontmatter 解析前统一做 `CRLF -> LF`
- bundle sections 统一做 Unicode normalization

### 统一目录发现规则

- builtin 来源不依赖文件系统路径语义
- workspace/user skill 目录发现必须通过 `catalog/discovery` 统一处理
- 所有平台差异只能收口在 discovery 层，禁止在 commands/runtime 中散落 `replace('\\', '/')`

## Library Strategy

### Must Use Existing Libraries

- `serde_yaml`
  - frontmatter 解析
- `globset`
  - conditional skill 路径规则
- `camino`
  - UTF-8 路径统一
- `notify`
  - watcher
- `unicode-normalization`
  - 文本规范化
- `indexmap`
  - 保序去重

### Must Be Custom

- `SkillActivationEngine`
- `SessionSkillState` 协议
- `ResolvedSkillSet` 归并规则
- prompt budget 下的 active/visible skill 渲染逻辑
- route policy 到 activation intents 的映射

## File-Level Migration Plan

### New Files

- `src-tauri/src/skills/catalog.rs`
- `src-tauri/src/skills/discovery.rs`
- `src-tauri/src/skills/conditional.rs`
- `src-tauri/src/skills/activation.rs`
- `src-tauri/src/skills/prompt.rs`
- `src-tauri/src/skills/executor.rs`
- `src-tauri/src/skills/state.rs`
- `src-tauri/src/runtime/system_prompt.rs`

### Existing Files To Refactor

- [src-tauri/src/persistence/mod.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/persistence/mod.rs)
  - builtin skill 注册迁出到 `skills/bundled.rs`
- [src-tauri/src/commands/chat.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/chat.rs)
  - 迁出 metadata activeSkills merge
- [src-tauri/src/commands/skills_ai.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/skills_ai.rs)
  - 迁出 invoke -> metadata merge
- [src-tauri/src/interactive_runtime_shared.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/interactive_runtime_shared.rs)
  - 改为只消费 `ResolvedSkillSet`
- [src-tauri/src/skills/runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/skills/runtime.rs)
  - 缩减为 facade / compatibility bridge
- [src/pages/Wander.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Wander.tsx)
  - `activeSkills` 改为 `requestedSkills`
- [src/features/chat/editorSessionBinding.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/features/chat/editorSessionBinding.ts)
  - `activeSkills` 改为 `requestedSkills`

### Existing Files To Delete Eventually

- 直接读写 `metadata.activeSkills` 的所有业务逻辑
- `skills/runtime.rs` 里承担激活职责的旧函数

## Migration Stages

### Stage 1: Catalog Foundation

目标：

- 建立统一 catalog
- builtin / workspace / user skill 统一入 catalog
- 不改业务激活逻辑

完成标准：

- 能输出 `SkillCatalogEntry[]`
- 有 `catalog_fingerprint`
- watcher 可正常工作

### Stage 2: Activation Engine

目标：

- 建立 `SkillActivationIntent`
- 建立 `SessionSkillState`
- chat / wander / editor 能写 activation state

完成标准：

- 不再新写 `metadata.activeSkills`
- 新会话首条消息可稳定激活 session 级技能

### Stage 3: Prompt Cutover

目标：

- prompt 组装只吃 `ResolvedSkillSet`
- visible 和 active 分离

完成标准：

- `interactive_runtime_shared.rs` 不再自己猜 activeSkills

### Stage 4: Executor Cutover

目标：

- `skills:invoke` 走 executor
- turn/session scope 都走 activation engine

完成标准：

- `skills_ai.rs` 不再自己 merge session metadata

### Stage 5: Legacy Cleanup

目标：

- 删除旧的 `activeSkills` 主链路
- 删除 runtime 里的重复激活逻辑

完成标准：

- 技能系统主链只剩 catalog -> activation -> prompt -> executor

## Atomic Commit Plan

必须严格按原子提交推进，每个提交只做一件事。

### Commit 1

`Introduce unified skill catalog and bundled source registry`

包含：

- 新建 `catalog.rs`
- 新建 `bundled.rs`
- builtin skill 从 persistence 迁移到 bundled registry
- 补 catalog 单测

### Commit 2

`Add cross-platform skill discovery and bundle normalization`

包含：

- 新建 `discovery.rs`
- 统一路径和换行规范化
- workspace/user/builtin bundle 统一读取
- 补 Windows/macOS path tests

### Commit 3

`Add session skill state and activation intent engine`

包含：

- 新建 `activation.rs`
- 新建 `state.rs`
- 引入 `SkillActivationIntent`
- 引入 `SessionSkillState`
- 补激活归并测试

### Commit 4

`Route chat and wander skill requests through activation engine`

包含：

- 改 `commands/chat.rs`
- 改 `chat_sessions_wander.rs`
- 改 session ensure + activation write path
- 修复新会话首条消息技能丢失问题

### Commit 5

`Refactor runtime prompt assembly to consume resolved skill sets`

包含：

- 新建 `prompt.rs`
- 改 `interactive_runtime_shared.rs`
- active/visible skill 分离注入
- 补 prompt snapshot tests

### Commit 6

`Move skill invocation and scope handling into executor`

包含：

- 新建 `executor.rs`
- 改 `commands/skills_ai.rs`
- turn/session scope 统一
- 补 invoke lifecycle tests

### Commit 7

`Migrate frontend task hints from active skills to requested skills`

包含：

- 改 `Wander.tsx`
- 改 editor binding
- 改类型定义
- 移除前端对最终 active state 的假设

### Commit 8

`Remove legacy metadata.activeSkills dependency`

包含：

- 删除旧读写逻辑
- 保留一次性迁移兼容
- 补完整 e2e

## Test Matrix

### Unit Tests

- catalog priority
- builtin dedup
- frontmatter parsing with CRLF
- path normalization with backslashes
- activation merge precedence
- runtime mode rejection
- turn vs session scope
- prompt bundle budget trimming

### Integration Tests

- workspace builtin + custom skill coexist
- explicit invoke updates session skill state
- conditional skill activates when touched path matches
- session restore rebuilds active skill set

### End-To-End Tests

- Chat 新会话首条消息请求 `writing-style`
- Wander deep think with `writing-style`
- RedClaw authoring session keeps `writing-style`
- Windows slash path + CRLF skill body
- macOS builtin skill injection parity

## Risks And Guardrails

### Risk 1

重构期间新旧链路并存，容易双写 skill state。

约束：

- 任何入口只能调用 `activation.rs`
- 新代码禁止直接写 `metadata.activeSkills`

### Risk 2

prompt token 体积膨胀。

约束：

- visible skills 只给摘要
- active skills 才给正文
- references/rules/scripts 懒加载

### Risk 3

Windows 路径兼容被遗漏。

约束：

- 所有逻辑路径统一 slash
- 只在 discovery 层接触平台路径差异
- Windows CI 覆盖 catalog/discovery/conditional

### Risk 4

前端仍然把 skill 当成“最终状态”而不是“请求意图”。

约束：

- 类型层废弃 `activeSkills`
- 前端只保留 `requestedSkills`

## Acceptance Criteria

本方案完成时，必须同时满足：

1. `writing-style` 在 Windows 和 macOS 下的注入行为一致。
2. 新会话首条消息可以激活 session 级技能。
3. skill 激活结果由 `SessionSkillState` 唯一表达。
4. system prompt 不再依赖直接读取 `metadata.activeSkills`。
5. builtin、workspace、user skill 统一进入同一 catalog。
6. 显式 invoke、自动激活、条件激活共享同一条 activation engine。

## Recommendation

推荐立即按这份文档执行 `方案 C`：

- 发现层采用 `aionrs` 的统一 catalog 思路
- 条件激活层采用 `aionrs` 的 dormant/activated 模式
- 执行层采用显式 executor 和 hooks 回流
- 会话级激活和 route policy 由 LexBox 自己的 activation engine 负责

这比继续修 `taskHints`、`activeSkills`、路径补丁更稳，也比直接照抄 `aionrs` 的纯 Skill Tool 模式更适合 LexBox 的产品工作流。
