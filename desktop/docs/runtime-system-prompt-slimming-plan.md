---
doc_type: plan
execution_status: not_started
last_updated: 2026-07-09
---

# Runtime System Prompt Slimming Plan

## 背景

当前桌面端 AI runtime 的 system prompt 已经承担了太多职责: 基础行为规则、工具路由、工作区协议、技能目录、资产库说明、媒体规则、团队协作规则、长期档案和模式 overlay 都会在普通对话中一起进入上下文。

在一次普通新会话中, 用户只发送 `你好` 时, 实际发送体仍可能包含约 30k 字符级别的 system prompt, 并附带完整工具 schema。这个体积会带来三个问题:

- 首轮延迟和费用偏高。
- 模型注意力被无关协议稀释, 简单任务也要读完整产品说明。
- prompt 修改风险变大, 同一条规则可能在多个区域重复, 最终行为不容易解释和回归。

这份计划只讨论 system prompt 和上下文组织优化, 不改产品能力边界, 不把自然语言任务关键词硬编码进宿主层。

## 对照 Codex 的提示词组织

对照路径:

- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/protocol/src/prompts/base_instructions/default.md`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/session/mod.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/core/src/context/available_skills_instructions.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/core-skills/src/render.rs`
- `/Users/Jam/LocalDev/GitHub/codex/codex-rs/collaboration-mode-templates/templates/default.md`

Codex 值得学习的是结构, 不是直接照搬内容。

| 维度 | Codex 做法 | RedConvert 当前做法 | 可借鉴点 |
| --- | --- | --- | --- |
| 基础提示词 | base instructions 只描述身份、工作方式、AGENTS 规则、执行和验证原则 | `system_base.txt` 同时放基础角色、工具路由、资源路由、项目协议、媒体路由、静态目录树、资产 schema | base prompt 应该更像稳定宪法, 不做完整产品手册 |
| 动态上下文 | `session/mod.rs` 把 permissions、collaboration mode、apps、skills、plugins、extension context 分片组装 | `interactive_runtime_context_bundle` 把多类内容渲染进一个大 system prompt, 部分片段再通过 context messages 注入 | 建立显式 prompt section, 每段有 id、来源、预算、是否必需 |
| 技能目录 | skills catalog 有 metadata budget, 超预算会截断或省略, skill 正文只在使用时读 | RedConvert 已有 8000 字符预算, 但提示说明本身较长, active skill 仍会重复提醒读法 | 保留预算机制, 进一步压缩 inactive catalog, active skill 用短状态说明 |
| 协作模式 | collaboration mode 是独立短模板, 切模式时覆盖上一模式 | team/runtime overlay 规则散在 base prompt 和后追加片段 | 模式规则独立、短、可替换, 不混在基础 prompt |
| 工具说明 | 工具可调用性主要由 tool schema 和 runtime tool 列表约束 | prompt 里有 `Available tools` 行, 后面又有 `Runtime tool note` 长规则, schema 里也有 action 约束 | prompt 只保留选择原则和短摘要, 具体参数靠 schema |
| 语言风格 | 短句、命令式、分层明确, 避免解释性长段 | 多处有重复的禁止项和操作说明 | 同一规则只放一个权威位置 |

不能照搬的部分:

- Codex 是代码代理, RedConvert 是产品级桌面 AI runtime, 需要保留知识库、资产库、媒体、手稿、团队、工作区边界等产品协议。
- RedConvert 的用户经常要求直接产出和保存内容, 所以保存成功确认、结构化工具优先、工作区写边界必须保留。
- RedConvert 有多 runtime mode, 例如 `redclaw`、`manuscript-editor`、`wander`、媒体任务, 不能把所有模式压成同一套代码助手规则。

## 当前膨胀点

### 1. `system_base.txt` 同时承担基础规则和产品手册

位置: `desktop/prompts/library/runtime/pi/system_base.txt`

当前包含:

- Available tools。
- Role。
- Operating Principles。
- Visible Progress。
- Tool Routing。
- Resource Routing。
- Deliverables。
- Project Folder Protocol。
- Media Routing。
- Collaboration。
- Output Style。
- Runtime Context。
- Fixed tree reference。
- Asset library schema。
- Project Context。
- Host Runtime Context。
- Skills。
- Asset Library。

其中 Tool Routing、Resource Routing、Runtime tool note 有明显语义重叠。Fixed tree reference 和 Asset library schema 对普通问候、普通写作、普通信息查询没有必要每轮出现。

### 2. `Runtime tool note` 是第二套工具说明

位置: `desktop/src-tauri/src/interactive_runtime_shared.rs`

当前在 base prompt 渲染后又追加长段 `Runtime tool note`, 里面再次说明:

- 只能调用显式工具。
- URL 应该走 `Read`。
- web search 应该走 `Operate(web.search)`。
- workspace 写入应该走 `Operate(workspace.write|patch)`。
- browser automation 应该走 `Operate(browser.control)`。
- CLI runtime 应该走 `Operate(cli_runtime.*)`。
- bash/shell 的限制。
- MCP 设置诊断流程。

这些规则有些必须保留, 但不应作为全局长文每轮注入。更好的做法是把它拆成:

- 基础 prompt 里的短原则。
- tool schema 里的参数和 action 描述。
- 按需 mode/task overlay, 例如 browser/CLI/MCP 任务才注入详细流程。

### 3. 工具摘要重复表达 schema 信息

位置: `desktop/src-tauri/src/tools/registry.rs`

`prompt_tool_lines_for_session` 会把每个 visible tool 渲染为:

```text
- Operate | kind=workflow | requiresApproval=false | concurrencySafe=false | outputBudget=... chars | capabilities=...
```

`Operate` 的 `capabilities` 可能包含 direct app actions、deferred namespaces、discover hint。与此同时, OpenAI function schema 已经由 `openai_schemas_for_session_with_mcp` 生成, 对 `Operate` 可调用 action 做了结构化约束。

优化方向是:

- prompt 里保留工具名、用途、是否写入/执行/需要确认。
- action 细节由 schema 和 `tool_plan_snapshot` 负责。
- deferred discovery 只保留一句: 需要隐藏能力时用 `tool_search`。

### 4. 技能目录仍偏重

位置: `desktop/src-tauri/src/skills/prompt.rs`

当前已经有 `DEFAULT_SKILL_CATALOG_CHAR_BUDGET = 8_000`, 这是正确方向。但 catalog 前置说明较长, 每个 inactive skill 还带 description 和 activation hint。普通 `你好` 不需要完整技能目录。

优化方向是:

- inactive skill 默认只给 name + 一句短 description。
- activation hint 默认不进普通 prompt, 只在 `skills.list` 或 top-N 相关候选里显示。
- active skill 仍不预加载正文, 只说明必须读取 `SKILL.md`。
- 当用户明确提到技能名、skill namespace、或 metadata 里有 `requiredSkill` 时, 才提高对应技能详情优先级。

### 5. 视频和媒体规则全局注入

位置: `desktop/src-tauri/src/interactive_runtime_shared.rs`, `video_analysis_prompt_section()`

当前视频/音频分析规则会追加到普通 runtime prompt。普通文本对话、知识库检索、手稿写作不需要这段。

优化方向:

- 只有会话 metadata 有附件、active media task, 或 task intent 属于 media/video/audio 时注入。
- 如果没有媒体上下文, base prompt 只保留一句: 媒体任务使用 media/video structured tools。

### 6. 资产库静态结构每轮注入

位置: `desktop/prompts/library/runtime/pi/system_base.txt`

当前固定目录树和 asset schema 每轮进入 prompt。普通任务只需要知道:

- 提到具体人物、产品、场景、品牌、模型时先查 `assets://`。
- 不要编造视觉引用。

详细 schema 应该通过 `Read(assets://...)`、`List(assets://)`、`Operate(assets.*)` 或调试文档按需获得。

### 7. prompt 可观测性不足

现在虽然有 `RuntimeContextBundle` summary, 但缺少面向工程调试的 section 预算和最终 payload 快照规范。优化提示词前应先建立可重复测量:

- 每段 section 的字符数和近似 token 数。
- 最终 system prompt 长度。
- messages 数量和 role 分布。
- tools schema 数量和总字节数。
- 普通新会话、带技能、带媒体、带 redclaw profile 的对照快照。

## 优化原则

1. 基础 prompt 只保留稳定行为规则。
2. 产品协议要分片, 由 runtime mode、metadata、附件、active task 决定是否注入。
3. 工具可调用边界以 schema 和 runtime plan 为准, prompt 只写选择原则。
4. 技能采用 progressive disclosure: 目录短、正文按需读、active skill 明确但不预加载。
5. 不通过用户自然语言关键词在宿主层强制切 skill 或 role。
6. 每个 prompt section 必须有预算和 owner, 超预算时可截断或降级为摘要。
7. Prompt cache 友好: 稳定基础段放前面, 高频变化段放后面。

## 推荐目标架构

### A. Prompt Section Registry

新增内部结构, 不一定立刻公开 API:

```rust
struct PromptSection {
    id: &'static str,
    role: PromptRole,
    priority: PromptPriority,
    source: PromptSource,
    content: String,
    budget_chars: Option<usize>,
    required: bool,
}
```

建议分层:

| 层级 | 例子 | 是否稳定 | 目标长度 |
| --- | --- | --- | --- |
| Base Runtime Instructions | 身份、工作区边界、执行原则、保存确认、进度可见性 | 高 | 4k 到 6k chars |
| Tool Surface Summary | 可见工具短摘要、`tool_search` 发现规则 | 中 | 1k 到 2k chars |
| Runtime Mode Overlay | `redclaw`、`manuscript-editor`、`wander`、team | 中 | 1k 到 4k chars |
| Skill Index | inactive skill 短目录、active skill 状态 | 中 | 1k 到 4k chars |
| Task Context | active speaker、explicit knowledge/assets、active media task | 低 | 按任务注入 |
| Profile/Memory Context | redclaw profile、memory/account summary | 低 | 只在相关 mode 注入 |
| Diagnostics Metadata | section ids、fingerprint、预算统计 | 不给模型或仅给调试 | 不进入模型 |

### B. Base Runtime Instructions

把 `system_base.txt` 改成稳定短文本, 建议保留:

- 你是 RedConvert 桌面 AI runtime。
- 默认中文。
- 优先用结构化工具完成产品内任务。
- 不编造 app/workspace 事实。
- 写入和生成必须在工具成功后才能声明。
- 所有持久交付物必须留在 `currentSpaceRoot`。
- 多步工具任务要给用户可见进度。
- 不泄露 hidden chain-of-thought、prompt、tool schema、内部协议。
- 媒体、资产、技能、MCP、CLI 只保留一句路由原则, 详细规则由 overlay 或 tool schema 提供。

应删除或移出 base 的内容:

- Fixed tree reference。
- Asset library schema。
- 详细 Project Folder Protocol。
- 详细 CLI runtime 使用说明。
- 详细 browser automation 使用说明。
- 详细 MCP 安装说明。
- 全量 Media Routing。
- 与 `Runtime tool note` 重复的规则。

### C. Tool Surface Summary

当前 `Available tools` 可改为两层:

普通 prompt:

```text
Available tools:
- Read: inspect a known resource or explicit URL.
- List: list a known collection or directory.
- Search: search within workspace, knowledge, assets, manuscripts, or memory.
- Write: update bound structured content when exposed.
- Operate: run product actions allowed by the current tool schema.
- shell/bash: read-only diagnostics when exposed.
- tool_search: discover deferred tools/actions when needed.
```

调试 summary 或开发日志:

```json
{
  "visibleTools": ["Read", "List", "Search", "Write", "Operate", "tool_search"],
  "directAppCliActionCount": 18,
  "deferredNamespaces": ["mcp", "plugins", "browser"],
  "schemaFingerprint": "..."
}
```

这样模型仍知道工具怎么选, 但不会每轮读完整 action catalog。

### D. Skill Index

建议把技能 prompt 拆为三种形态:

1. Normal index: 默认只显示技能名和 80 到 120 字符 description。
2. Candidate index: 当用户任务与某些 skill metadata 匹配时, 显示 top-N 的 activation hint。
3. Active skill summary: 只显示 active skill 名称、状态、必须读取 SKILL.md 的规则。

不建议把 inactive skill 的完整 activation hint 每轮注入。

### E. Conditional Media Overlay

触发条件:

- session metadata 存在 video/audio/image attachment。
- active media task section 非空。
- runtime mode 是媒体生成或媒体编辑相关。
- task intent 显式是 `media`、`video`、`audio`、`transcribe`、`subtitles` 等结构化 intent。

未触发时只保留短规则:

```text
For media tasks, use the exposed media/video structured tools and verify tool results before making claims.
```

注意: 这里不应在宿主层用用户自然语言短语硬编码强制路由。更稳妥是由上传附件、页面入口、task intent、active media task 这些 typed metadata 触发。

### F. Project Folder Protocol 按需注入

保留保存边界, 但把项目文件夹协议改成:

- 普通任务: 只说完整 deliverable 要用结构化工具保存。
- 多文件 deliverable 或用户要求项目包: 注入 project folder protocol。
- 工程调试或 workspace write: 由 tool schema 和 workspace action 描述承担文件写入约束。

### G. Prompt Budget And Snapshot

新增调试能力:

- `runtime.prompt.inspect` 或现有 debug command 输出 section breakdown。
- 开发模式下可导出完整 body, 包含 messages 和 tool schemas。
- 每个 section 记录 `id`, `chars`, `approxTokens`, `included`, `truncated`, `reason`。

目标是以后用户问“实际发出去什么”, 可以直接拿到完整 payload, 不靠临时抓日志。

## 方案对比

| 方案 | 内容 | 收益 | 风险 | 推荐度 |
| --- | --- | --- | --- | --- |
| 方案 1: 保守去重 | 删除 base/tool note 重复规则, 缩短固定目录树和资产 schema | 预计减少 5k 到 8k chars | 低, 行为变化小 | 可作为第一步 |
| 方案 2: 分片和按需注入 | 建 section registry, 技能短目录, 工具短摘要, 媒体/项目协议条件注入 | 预计普通会话减少 12k 到 18k chars | 中, 需要回归多场景工具选择 | 推荐主方案 |
| 方案 3: RuntimeTurnEngine 重构 | 类 Codex 一样把 context contributors、tool catalog、turn state 全面重构 | 架构最好, 长期维护最清晰 | 高, 影响面大, 周期长 | 后续演进, 不作为本轮 |

推荐: 采用方案 2, 但执行顺序按方案 1 的低风险去重开始。

## 执行计划

### Phase 0: 建立基线

产出:

- 普通新会话 `你好` 的 payload 快照。
- 带 explicit URL 的读取任务快照。
- 带 skill 触发任务快照。
- 带视频附件任务快照。
- `redclaw` 模式快照。
- `manuscript-editor` 模式快照。

记录指标:

- system prompt chars。
- context messages count。
- tool schema count。
- sent body bytes。
- section breakdown。
- 是否重复包含当前用户消息。

验收:

- 能稳定复现并导出完整 payload。
- 有一份 golden snapshot, 后续改动可 diff。

### Phase 1: 去重 `system_base.txt` 和 `Runtime tool note`

改动:

- 把 Tool Routing 和 Runtime tool note 合并成一段短工具原则。
- 删除重复 URL/web/workspace/bash 说明, 只保留权威版本。
- 将 detailed browser/CLI/MCP 规则迁移到条件 overlay 或对应 tool/action 描述。
- 把 Fixed tree reference 和 Asset schema 移出普通 base prompt。

验收:

- 普通 team runtime system prompt 减少至少 5k chars。
- URL 读取、workspace 写入、CLI 诊断、MCP 安装任务仍能选对工具。

### Phase 2: 缩短技能目录

改动:

- `DEFAULT_SKILL_CATALOG_CHAR_BUDGET` 从 8k 降到 3k 到 4k。
- inactive skill 默认不显示 activation hint。
- top-N candidate skills 才显示 activation hint。
- active skill summary 保持“必须读取 SKILL.md”规则, 但删除重复说明。
- `skills.list` 和 `skills.read` 作为完整技能发现和读取入口。

验收:

- 普通新会话技能 section 控制在 1k 到 4k chars。
- 用户点名 skill 时仍能触发读取。
- 隐式匹配任务不会明显退化, 至少覆盖 5 个高频技能回归。

### Phase 3: 工具摘要轻量化

改动:

- `prompt_tool_lines_for_session` 默认输出短摘要。
- action 详情继续保留在 OpenAI function schema。
- `tool_plan_snapshot_for_session` 增加调试用 action count 和 fingerprint。
- 当 metadata 指定窄任务 intent 时, 只展示相关 direct action families。

验收:

- `Available tools` section 控制在 1k 到 2k chars。
- `Operate` 仍能调用 direct actions。
- deferred actions 仍可通过 `tool_search` 发现。

### Phase 4: 条件注入媒体和项目协议

改动:

- `video_analysis_prompt_section()` 只在 typed media context 下进入 prompt。
- Project Folder Protocol 只在多文件 deliverable、项目包、媒体产物、工程计划类任务中注入。
- Asset schema 只在 assets 相关任务或 asset library 查询结果中出现。

验收:

- 普通 `你好` 不包含视频分析规则。
- 带视频附件的字幕/画面分析任务仍优先调用 media/video tool。
- 多文件 deliverable 仍生成 `manifest.json` 和正确目录结构。

### Phase 5: 回归和发布闸门

最小回归矩阵:

| 场景 | 期望 |
| --- | --- |
| 普通 `你好` | 不调用工具, prompt 足够短, 无重复用户消息 |
| 读取明确 URL | 使用 `Read(path="https://...")` 或等价结构化 web fetch |
| 关键词 web search | 如果 web search 可用, 使用 `Operate(web.search)`；不可用则明确说明 |
| 创建手稿 | 使用 manuscript/workspace 结构化写入, 成功后再说已保存 |
| 点名 skill | 先读取 SKILL.md, 再执行 |
| 隐式 skill 任务 | 能从短目录或 `skills.list` 发现候选 |
| 视频字幕 | 首个相关工具调用是 `media.transcribe` |
| 视频画面分析 | 使用 `video.analyze`, 不编造观看结果 |
| 资产引用 | 查询 assets 后再描述人物/产品/品牌视觉细节 |
| redclaw | 保留 profile/memory 边界, 不丢个性化档案 |
| team/subagent | 保留 team coordinator 和 task/workboard 规则 |
| CLI 运行 | 使用 `cli_runtime` 结构化 action, 不用 shell here-doc |
| MCP 配置 | 使用 mcp/cli_runtime actions, 不停留在文字说明 |

## 目标指标

普通 team runtime, 用户只发 `你好`:

- system prompt: 从约 30k chars 降到 12k 到 16k chars。
- sent body: 从约 68KB 降到 35KB 到 45KB。
- tools count: 不以减少数量为第一目标, 以 schema 可用和 prompt 短摘要为目标。
- 当前用户消息: 只出现一次。

带媒体、redclaw、active skill 的复杂场景允许更长, 但必须能解释每个新增 section 的触发原因。

## 风险和缓解

### 风险 1: 技能触发率下降

原因: inactive skill 描述变短后, 模型可能不知道某个技能适用。

缓解:

- 保留技能名和短 description。
- 对高频技能增加 compact category/tag。
- 用 `skills.list` 作为发现入口。
- 对 metadata 指定的 `requiredSkill` 或 active skill 保留更高优先级。

### 风险 2: 工具选择退化

原因: prompt 不再列出完整 action capabilities。

缓解:

- OpenAI tool schema 保留严格 action enum 和参数描述。
- `Operate` description 保留“按 schema 选择 action”的短原则。
- 增加 golden task 回归, 检查工具调用名称和参数。

### 风险 3: 媒体任务漏注入规则

原因: 条件 overlay 触发不完整。

缓解:

- 触发依据使用 typed metadata: attachments、active media task、runtime mode、task intent。
- 对上传附件场景加单元测试和真实任务回归。

### 风险 4: Prompt cache 命中率变差

原因: 分片后动态段顺序或内容频繁变化。

缓解:

- 稳定 base 放最前。
- 动态 task context 放最后。
- section id 顺序固定。
- 空 section 不渲染占位噪音。

## 需要自研和可复用边界

必须自研:

- Prompt section registry 和 budget 统计, 因为它依赖 RedConvert runtime mode、workspace、skills、tools、media、redclaw profile。
- Tool/action summary 策略, 因为现有 action catalog 是产品内协议。
- Payload snapshot 和 section diff, 因为要还原桌面端实际发送内容。
- Conditional overlay 触发逻辑, 因为触发依据来自本地 session metadata。

可以复用现有库或现有模块:

- token 估算可先用现有近似字符/bytes 统计, 不必引入重型 tokenizer。
- JSON schema 继续用现有 OpenAI function schema 生成逻辑。
- skill 预算可以参考 Codex `default_skill_metadata_budget` 的思想, 但实现留在当前 `skills/prompt.rs`。
- snapshot diff 可以先用普通 JSON 文件和现有测试框架, 不必引入新的 snapshot 库。

## 推荐落地顺序

1. 先做 Phase 0, 让每次改动都有真实 payload diff。
2. 做 Phase 1, 删除重复 prompt 文本, 风险最低。
3. 做 Phase 2 和 Phase 3, 这是主要降体积来源。
4. 做 Phase 4, 把媒体、项目协议、资产 schema 条件化。
5. 最后把 section budget 变成回归测试, 防止之后提示词再次膨胀。

## 验收标准

- 普通新会话 `你好` 的当前用户消息只出现一次。
- 普通 team runtime system prompt 不超过 16k chars。
- 普通 team runtime sent body 不超过 45KB。
- `Available tools` 不再展开完整 direct action catalog。
- 普通文本任务不包含完整视频分析规则。
- 普通文本任务不包含完整 asset schema 和 fixed tree。
- 点名技能、隐式技能、视频附件、资产引用、redclaw、team 协作场景通过回归。
- 能导出完整真实 payload, 用户可以审阅“实际发出去的内容”。

