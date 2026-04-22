---
doc_type: investigation
execution_status: completed
last_updated: 2026-04-21
owner: codex
target_files:
  - src/pages/Wander.tsx
  - src/utils/redclawAuthoring.ts
  - src-tauri/src/commands/chat.rs
  - src-tauri/src/interactive_runtime_shared.rs
  - src-tauri/src/main.rs
  - src-tauri/src/tools/app_cli.rs
success_metrics:
  - 能解释 RedClaw/Wander 创作链中 create-project 后为何坍缩为空 app_cli 调用
  - 能解释 writing-style 在这条链路中为何对用户“不可见”
  - 能区分 prompt 缺口、工具抽象缺口、loop guard 协议缺口各自的责任边界
---

# RedClaw / Wander 稿件创作链路根因调查

## 1. 调查范围

本次调查针对一条具体失败链路：

- 运行模式：`redclaw`
- 模型：`qwen3.5-plus`
- 任务类型：`manuscript_creation`
- 来源：`Wander -> RedClaw` 创作跳转
- 目标：读取素材与用户档案，创建 `.redpost` 工程，写入完整稿件并保存

核心 session：

- `session-1776780178912`

关键证据来源：

- [session-transcripts/session-1776780178912.jsonl](</Users/Jam/Library/Application Support/RedBox/session-transcripts/session-1776780178912.jsonl>)
- [session-bundles/session-1776780178912.json](</Users/Jam/Library/Application Support/RedBox/session-bundles/session-1776780178912.json>)
- [redbox-state.json](</Users/Jam/Library/Application Support/RedBox/redbox-state.json>)

## 2. 已确认事实

### 2.1 素材读取与 profile 读取并没有失败

这条会话实际完成了以下工具调用：

1. `app_cli(command="redclaw profile-bundle")`
2. 3 个素材目录的 `redbox_fs(action="list")`
3. 7 个素材文件的 `redbox_fs(action="read")`

这意味着：

- `requireProfileRead` 已满足
- `requireSourceRead` 已满足
- 问题不在素材读取阶段

### 2.2 `.redpost` 工程创建成功

工具调用：

- `app_cli(command="manuscripts create-project --kind redpost --parent wander --title 我做AI副项目第45周才想明白：省钱不是第一原则")`

返回结果包含：

- `projectPath = wander/redpost-1776780906630.redpost`
- `contentPath = wander/redpost-1776780906630.redpost/content.md`
- `entryPath = wander/redpost-1776780906630.redpost/content.md`

所以：

- 工程创建逻辑是正常的
- 宿主已经返回了后续写入所需的目标路径

### 2.3 真正失败点发生在 create-project 之后

create-project 成功后，模型没有继续生成：

- `app_cli(command="manuscripts write --path ...", payload={...})`

而是连续两轮生成：

- `app_cli({})`

宿主返回：

- `command is required`

随后因为两轮工具结果完全相同，被 loop guard 判定为“重复且无推进”，进入 forced finalization。

### 2.4 forced finalization 之后又触发了 OpenAI 兼容协议错误

loop guard 收尾后，OpenAI/Qwen 请求报错：

- `[] is too short - 'tools'`

这说明 forced-toolless turn 仍然发送了：

- `tool_choice = "none"`
- `tools = []`

而当前上游兼容实现不接受空 `tools` 数组。

这不是本次任务为什么没写入稿件的首要原因，但它让原本应该“优雅收尾”的保护回合直接再次失败。

## 3. 当前链路中的三个根因

### 3.1 Prompt 根因：Wander 创作消息里的保存指令是残缺的

在 [src/pages/Wander.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/Wander.tsx) 中，创作提示里：

- 第 4 条给了完整的 `manuscripts create-project` 模板
- 第 6 条只写到：`完成后必须调用 app_cli 将完整稿件保存到 manuscripts。优先使用：`
- 但没有把实际的 `manuscripts write --path ...` 模板写完整

这会直接造成：

- 模型知道“下一步应该保存”
- 但没有拿到保存命令的稳定模板
- 在宽工具 `app_cli` 下容易退化成空调用

### 3.2 工具抽象根因：`app_cli(command: string)` 对关键保存动作过于宽泛

`app_cli` 的 schema 只要求：

- `command: string`
- `payload?: object`

见 [src-tauri/src/tools/catalog.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/catalog.rs)。

这意味着模型必须自己完成：

1. 选择 namespace
2. 拼接 CLI 字符串
3. 决定 `--path`
4. 决定正文是走 `payload.content` 还是命令参数

对于 `create-project`，因为 prompt 给了完整模板，所以模型能成功。

对于 `write`，因为 prompt 没给模板，所以模型没有任何结构化护栏，直接退化为：

- `app_cli({})`

### 3.3 技能可见性根因：`writing-style` 被静默注入，而不是显式 invoke

这条 session 在本地状态里确实已经带有：

- `metadata.activeSkills = ["writing-style"]`
- `metadata.taskHints.activeSkills = ["writing-style"]`

说明 `writing-style` 并不是没进 session。

但 transcript 中没有任何一次：

- `app_cli(command="skills invoke --name writing-style")`

结合现有运行时实现，可推断当前行为是：

1. `taskHints.activeSkills` 进入 session metadata
2. `interactive_runtime_system_prompt()` 通过 skill runtime 把 `promptPrefix/promptSuffix/contextNote/skillsSection` 注入 system prompt
3. 模型在 system prompt 里被告知该技能已 active，因此不会再显式 invoke

这导致两个后果：

- 从用户视角看，技能“没有被使用”
- 从模型视角看，技能是隐式激活，不会形成明确的 activation transition 和后续 continuation

换句话说，当前系统对“技能已生效”的定义与用户对“技能被使用”的期望不一致。

补充确认：

- 该 session 在 [redbox-state.json](</Users/Jam/Library/Application Support/RedBox/redbox-state.json>) 的 `chatSessions` 中，`metadata.activeSkills` 与 `metadata.taskHints.activeSkills` 都已经是 `["writing-style"]`
- 因此本次不是“taskHints 没进 session”，而是“skill 进入 session 后以隐式 active 方式进入 system prompt”
- 这条设计会让 transcript 中看不到 `skills invoke`，从而让“技能是否被使用”在用户视角不可见

## 4. 更深一层的结构问题

### 4.1 RedClaw/Wander 创作链没有接入“绑定写稿目标”能力

`app_cli` 内部其实已经有两套能力：

1. 绑定编辑器会话目标：
   - `bound_writing_session_target()`
   - 面向编辑器绑定会话
2. 普通创作意图偏好：
   - `current_authoring_target_preference()`
   - 只知道扩展名、平台、子目录偏好

当前 RedClaw/Wander 创作链只接入了第二层，没有接入第一层。

这意味着：

- create-project 虽然成功返回了 `projectPath/contentPath`
- 但 runtime 没有把这个新创建的工程反写为“当前已绑定写稿目标”
- 后续 `manuscripts write` 仍然完全依赖模型自己显式提供 `--path`

所以这条链路本质上还是“create-project 成功，但 write 没有状态绑定”。

补充确认：

- `bound_writing_session_target()` 只识别 session metadata 里的：
  - `associatedPackageFilePath`
  - `associatedFilePath`
  - `associatedPackageKind`
- 这些字段来自编辑器绑定会话，而不是 Wander / RedClaw 创作链
- `manuscripts create-project` 虽然返回了：
  - `projectPath`
  - `contentPath`
  - `entryPath`
- 但当前没有代码把这些结果反写回 session metadata，供下一轮 `manuscripts write` 自动消费

### 4.2 Execution contract 只约束“必须保存”，没有约束“如何形成可执行保存动作”

当前 execution contract 能做到：

- 强制要求先读 profile
- 强制要求先读素材
- 强制要求最终必须 `manuscripts write`

但它做不到：

- 在 create-project 成功后自动把 `projectPath` 绑定成后续默认目标
- 给下一轮生成一个强结构的保存动作面
- 阻止模型用空的 `app_cli` 继续试探

所以当前 contract 的作用更像：

- “验收约束”

而不是：

- “执行引导”

### 4.3 loop guard 之后的 OpenAI body 构造与 Anthropic/Gemini 不一致

Anthropic/Gemini 路径在 forced-toolless 时，会直接省略工具定义。

但 OpenAI 这条链仍然会发送：

- `tools: []`

这属于 runtime 协议层不一致问题，会放大 loop guard 结束路径的失败率。

### 4.4 Prompt 与 tool schema 在保存动作上同时过宽

当前对模型暴露的两层信息都不足以稳定约束保存动作：

1. Prompt 层  
   - Wander 创作 prompt 的第 6 条断在“优先使用：”
   - 没有把 `manuscripts write --path <projectPath>` 的调用模板写完整

2. Tool 层  
   - runtime prompt 中的 `available_tools` 只会列出：
     - `app_cli | kind=app_cli | requiresApproval=...`
   - 不会把 `app_cli` 的 manuscripts 子命令、`payload.content` 用法、常见保存命令示例展开给模型
   - OpenAI tool schema 也只知道：
     - `command: string`
     - `payload: object`
   - 它不知道“当前任务已经创建了工程，下一步应当用哪个 path 执行 write”

因此这次失败并不是单一 prompt 断句，而是：

- 保存 prompt 不完整
- `app_cli` 保存动作过宽
- session 没有绑定 create-project 结果
- loop guard 收尾协议又不兼容 Qwen/OpenAI 兼容层

## 5. 已执行修复

本次调查后，已直接完成以下落地修复：

### 5.1 写稿保存动作改成宿主绑定目标

- `manuscripts create-project` 成功后，宿主会把：
  - `currentAuthoringProjectPath`
  - `currentAuthoringContentPath`
  - `currentAuthoringEntryPath`
  - `currentAuthoringProjectKind`
  - `currentAuthoringTitle`
  写入当前 session metadata
- `app_cli` 新增：
  - `manuscripts write-current`
- 后续保存不再依赖模型重新复述 `--path`

### 5.2 Wander / RedClaw prompt 改成稳定保存模板

- `Wander.tsx`
- `redclawAuthoring.ts`

现在都会明确要求：

- 先 `manuscripts create-project`
- 再直接 `app_cli(command="manuscripts write-current", payload={ "content": "<完整正文>" })`
- 禁止重新创建工程
- 禁止重复传 path

### 5.3 Runtime 在 create-project 后会自动续跑到 write-current

interactive runtime 现在会在：

- `manuscripts create-project` 成功后

自动追加内部 continuation，明确要求下一步直接调用：

- `manuscripts write-current`

这样模型不会再停留在“工程已创建，接下来开始写入”的口头阶段。

### 5.4 空的 `app_cli({})` 调用会被纠正，而不是直接被 loop guard 误杀

在 `manuscript_creation` 且当前工程已绑定的情况下：

- 如果模型调用了空的 `app_cli`
- 宿主会追加纠错指令，要求直接使用 `manuscripts write-current`
- 这一类纠错轮不会立刻按“重复无推进工具轮”进入 forced-toolless

### 5.5 OpenAI / Qwen forced-toolless 协议已修正

forced-toolless 回合现在：

- 仍然发送 `tool_choice = "none"`
- 但不再发送 `tools: []`

这修掉了此前的：

- `[] is too short - 'tools'`

### 5.6 Tool arguments 解析兼容对象型 arguments

OpenAI 兼容层现在不再只接受字符串型 `function.arguments`，也接受：

- object
- array
- bool / number / null

这样可以降低兼容 provider 在 non-streaming / fallback 回合里的参数丢失风险。

### 5.7 `writing-style` 的激活对用户可见

`taskHints.activeSkills` 现在会在运行前直接发出：

- `chat.skill_activated`

checkpoint，而不是等整轮任务结束后才补记。

这意味着：

- 从漫步跳 AI 创作时，`writing-style` 会立刻对用户可见
- 不再出现“系统里已经 active，但用户看不到技能被使用”的体验断层

## 6. 最终结论

这条链路的根因不是素材读取，也不是 create-project 本身失败，而是：

1. 保存动作缺少稳定模板
2. 保存工具抽象过宽
3. create-project 结果没有进入宿主状态
4. runtime 缺少 create-project 后的宿主续跑
5. loop guard 收尾协议又在 OpenAI/Qwen 路径上存在兼容性缺口

本次修复已经把这五层一起收掉，当前链路的正确执行模型变成：

1. 读取 profile 和素材
2. 创建工程
3. 宿主绑定当前工程
4. 宿主追加 continuation
5. 模型直接 `write-current`
6. 宿主完成保存
7. 再向用户汇报结果

- prompt 没给完整模板
- tool schema 没把保存动作结构化
- runtime 也没有绑定当前工程目标

三层同时偏宽，导致模型在最关键的保存动作上失去护栏。

## 5. 目前最可信的因果链

当前最可信的完整因果链如下：

1. Wander 构造了一个执行型创作任务，附带 `taskHints`
2. `taskHints.activeSkills = ["writing-style"]` 成功写入 session metadata
3. `writing-style` 因此被隐式注入 system prompt，而不是显式 `skills invoke`
4. 模型按要求完成了 profile/material 读取
5. 模型按 prompt 模板成功执行 `manuscripts create-project`
6. create-project 成功返回了 `projectPath/contentPath`
7. 但 runtime 没把新工程绑定成“当前写稿目标”
8. 同时 prompt 第 6 条又没有给出完整的 `manuscripts write` 模板
9. 模型在宽工具 `app_cli` 下失去保存动作约束，退化成 `app_cli({})`
10. 同样的空调用重复两轮
11. loop guard 正常判定为“重复且无推进”
12. forced-toolless turn 又因为 OpenAI `tools: []` 协议问题失败

## 6. 当前已排除的方向

以下方向目前可以排除为本次主因：

- 素材目录读取失败
- RedClaw 用户档案读取失败
- `.redpost` 工程创建失败
- API Key / 鉴权失败
- transport partial body / HTTP2 framing
- 数据库存不住 `activeSkills`

## 7. 当前最值得继续深挖的问题

### 7.1 为什么 create-project 成功后，没有形成“默认保存目标”

这是当前最关键的产品结构缺口。

需要继续确认：

- runtime 是否应该在 tool result 成功后，把 `projectPath` 写回 session metadata
- `app_cli manuscripts write` 是否应该允许“在 manuscript_creation 会话里省略 path”
- `current_authoring_target_preference()` 是否应该升级为“已解析的当前工程目标”

### 7.2 为什么 manuscript_creation 仍然依赖宽工具字符串，而不是结构化保存动作

需要继续确认：

- 是否应该新增结构化 `app_cli manuscripts save-draft` 风格命令面
- 还是让现有 `manuscripts write` 支持更稳定的 payload 合约
- 或者 runtime 在 create-project 成功后直接提供 continuation 指令，包含明确的 write 模板

### 7.3 `writing-style` 的隐式激活是否与当前产品预期冲突

从代码层面，它确实已进入 session metadata。

但从产品体验看，当前行为是：

- 系统认为它“已经 active”
- 用户看不到显式激活动作
- transcript 里也没有技能调用痕迹

这是否应该保留，还是应该改成显式 invoke + continuation，需要继续判断。

### 7.4 OpenAI/Qwen tool-call parser 是否还存在参数丢失风险

当前 `llm_transport/openai.rs` 的流式 parser 只在以下条件下拼接参数：

- `function.arguments` 是字符串

如果上游某次返回的是对象、数组，或其他非字符串形态，当前逻辑会直接忽略这部分参数，并最终把参数解析成 `{}`。

本次 session 中，`create-project` 的参数被正常解析，说明这次最直接的失败更可能是模型真的发了空参数，而不是 parser 吃掉了参数。

但这仍然是一个需要保留的结构性风险点，因为：

- 当前实现对 `function.arguments` 的形态假设过强
- 没有针对“非字符串 arguments”的兼容处理
- 一旦上游兼容模型在某些回合返回对象型 arguments，当前 host 会把它默默降成空对象

因此这次调查结论是：

- 本次主因不是 parser 丢参
- 但 parser 的参数形态兼容性仍然偏脆，需要作为后续单独检查项保留

## 8. 当前调查结论

本次故障不是单一 bug，而是三个层次的问题叠加：

1. Prompt 缺口：保存指令断句
2. 工具抽象缺口：`app_cli(command: string)` 过宽
3. Runtime 状态缺口：create-project 后没有绑定写稿目标

而 loop guard 之后的 `tools: []` 则是一个额外的协议缺口，会把本应“安全收尾”的失败路径再次放大。

当前最根本的问题不是“模型偶尔犯错”，而是：

- 系统把最关键的落盘动作仍然交给模型自由拼接
- 却没有在 create-project 成功后把保存动作收成稳定状态机
