# Hermes Agent 对 RedBox AI 系统的可借鉴清单

更新时间：2026-04-11

## 结论先行

`hermes-agent` 的先进之处，不在于“会调很多工具”，而在于它把 Agent 做成了一个完整系统：

- 有稳定的上下文装配层
- 有受控的长期记忆和跨会话检索
- 有技能沉淀与自我强化路径
- 有多入口统一运行时
- 有比较完整的安全边界
- 有自动化、子代理、插件、训练数据闭环

对 RedBox 来说，最值得借鉴的不是照搬 CLI 或 Telegram 形态，而是把你们已经存在的 `sessions / runtime transcripts / tool results / memory / skills / MCP / scheduler / assistant daemon` 这些能力，整理成一套更明确的 Agent 基础设施。

## RedBox 当前适配前提

根据仓库当前说明，RedBox 已经具备这些基础：

- Rust host 中已有 `chat / runtime / sessions / tasks / background`
- 已有 `assistant daemon / RedClaw / MCP / skills / diagnostics`
- 已有 `runtime transcripts / checkpoints / tool results`
- 已有 `memory:*`、`sessions:*`、`runtime:*`、`skills:*`、`background-tasks:*` 等 IPC 面

这意味着：RedBox 并不缺“零件”，更缺的是“清晰的 Agent 组织方式”。

## 一、最值得直接借鉴的部分

### 1. 分层上下文装配，而不是把所有规则塞进一个 prompt

Hermes 的做法：

- 将身份、项目约束、用户画像、长期记忆、技能、工具说明拆开管理
- `SOUL.md` 管人格
- `AGENTS.md` 管项目约束
- `MEMORY.md` / `USER.md` 管长期记忆
- 上下文文件在会话开始时装配成冻结快照
- 上下文文件进入 prompt 前先做注入扫描和截断

对 RedBox 的借鉴：

- 把现有系统提示拆成结构化上下文层，而不是继续堆长 prompt
- 区分“产品人格”“工作区规则”“用户偏好”“任务态记忆”“工具说明”
- 将其做成可视、可编辑、可审计的 Context Bundle

建议落地：

- 建一个 `agent context assembly` 层，统一生成每次会话的上下文快照
- 让 `workspace rules`、`user profile`、`memory summary`、`enabled skills` 分别有独立数据源
- 对导入的上下文文本做长度限制、危险模式扫描、来源标记

价值：

- 降低 prompt 污染
- 提高行为稳定性
- 让问题更容易定位到“是人格层、规则层、记忆层还是技能层”

### 2. 有边界的长期记忆，而不是无限聊天历史

Hermes 的做法：

- 长期记忆不是完整对话回放，而是受限、可整理、可替换的记忆块
- 跨会话检索走 `SQLite + FTS5`
- 会话存储包含消息、工具调用、tool result、prompt snapshot、session lineage
- 超长上下文时做压缩，但保留父子链路

对 RedBox 的借鉴：

- 你们已经有 `runtime transcripts / checkpoints / tool results / memory`
- 下一步应把“记忆”和“历史”分开
- “历史”是原始证据
- “记忆”是提炼后的稳定事实

建议落地：

- 将当前 memory 分成至少三层：
  - `User Profile`
  - `Workspace Facts`
  - `Task/Project Learnings`
- 将 session 检索升级为显式的“回忆工具”，不要只靠 UI 翻历史
- 给 session 增加 lineage 概念，支持压缩、分叉、恢复
- 将 tool result 纳入检索索引，而不只检索自然语言消息

价值：

- 让系统记住“事实”，不是只记住“对话表面”
- 能在长周期任务里减少重复确认
- 更适合你们已有的 background / daemon / scheduler 场景

### 3. 技能是程序化记忆，不只是模板市场

Hermes 的做法：

- 技能是按需加载的知识/流程单元
- 技能系统走渐进披露，避免每轮都灌入全部内容
- 技能既是能力入口，也是经验沉淀容器
- 官方强调技能可在复杂任务后形成、并在使用中持续改进

对 RedBox 的借鉴：

- 你们已经有 `skills:*` 和 market install 能力
- 下一步不要只把技能当“插件安装页”
- 应把技能定义成“稳定复用的任务协议”

建议落地：

- 技能元数据至少包含：
  - 适用场景
  - 需要的工具能力
  - 输入输出约束
  - 是否可自动触发
  - 是否允许写入 memory
- 将技能执行结果回流为“经验候选”，而不是直接覆盖技能
- 给技能加版本、来源、启用范围、风险等级

价值：

- 让系统可复用能力沉淀，而不是每次重新 prompt engineering
- 适合 RedBox 里 `RedClaw / assistant daemon / content workflows / publishing flows`

### 4. 多入口共用一个 Agent 核心

Hermes 的做法：

- 一个核心 agent loop 服务 CLI、gateway、cron、ACP/IDE
- 平台差异放在入口层，不放在 Agent 核心层
- 同一会话能力能跨 Telegram、Discord、CLI 连续存在

对 RedBox 的借鉴：

- 你们已有桌面 UI、daemon、hooks、scheduler、sidecar
- 应避免每个入口各自拼一套 AI 行为

建议落地：

- 抽出统一的 `Agent Runtime Core`
- 输入统一成 `TurnRequest`
- 输出统一成 `TurnResult / ToolCall / Event / Checkpoint`
- UI、daemon webhook、scheduler job、未来插件入口都走同一个 runtime

价值：

- 减少同逻辑多处维护
- 容易做统一审计、回放、计费、风控
- 对后续接入更多外部触发源很关键

### 5. 可观察、可中断、可恢复

Hermes 的做法：

- 工具调用对用户可见
- 执行过程可中断
- 会话有存储、压缩、检索、恢复、重试、切模型等控制面

对 RedBox 的借鉴：

- 你们已经有 `runtime:get-trace`、`runtime:get-checkpoints`、`chat:cancel`
- 这很接近 Hermes 的“可观察执行”

建议落地：

- 为每轮 agent 执行定义明确状态机：
  - `queued`
  - `running`
  - `awaiting_tool`
  - `awaiting_approval`
  - `completed`
  - `cancelled`
  - `failed`
- 在 UI 上区分“最终答案”和“中间执行证据”
- 支持从 checkpoint 恢复，而不是只能整轮重来

价值：

- 更适合长任务
- 更适合桌面端和后台混合执行
- 出问题时更容易 debug

### 6. 安全边界是体系，不是一个“确认弹窗”

Hermes 的做法：

- 危险命令审批
- 智能审批减少疲劳
- 容器/远程沙箱隔离
- MCP 凭据过滤
- 上下文文件注入扫描
- 消息平台还有 allowlist / DM pairing

对 RedBox 的借鉴：

- 你们已有本地文件、外部账号、MCP、sidecar、发布能力
- 这类系统一旦放开自动化，风险比普通聊天更高

建议落地：

- 把安全拆成独立层，不混在 prompt 里
- 至少增加：
  - 工具级风险分级
  - 参数级审批
  - MCP/sidecar 的凭据透传白名单
  - prompt/context 注入扫描
  - 发布类操作的二次确认与审计记录

价值：

- 这会直接决定系统能否安全地做自动化和后台运行

## 二、很值得做，但需要中间层改造的部分

### 7. Toolset / Capability Set，而不是“所有工具默认全开”

Hermes 的做法：

- 工具按 toolset 分组
- 不同平台、不同子代理可只拿到有限工具
- 子代理可限制无 shared memory 写权限

对 RedBox 的借鉴：

- 你们现在更像“能力已经很多，但权限边界不够显式”

建议落地：

- 为每次运行生成 `Capability Set`
- 按会话、技能、入口、任务类型裁剪工具暴露面
- 例如：
  - 纯研究任务不给发布工具
  - 内容润色任务不给本地 shell/sidecar
  - 自动计划任务不给高风险写权限

价值：

- 降低误操作面
- 也能减少模型选择工具时的噪音

### 8. 插件点要分层，不要把所有扩展都变成“大插件”

Hermes 的做法：

- 普通插件可注册 tools / hooks / commands
- memory provider 和 context engine 是专门的扩展点
- 可替换的是“某一层能力”，而不是只能整包魔改

对 RedBox 的借鉴：

- 你们已经有 MCP、hooks、skills、plugin 相关能力
- 但从系统演进角度，更关键的是定义“哪几层可以被替换”

建议落地：

- 明确至少四类扩展面：
  - `Tool Provider`
  - `Memory Provider`
  - `Context Provider`
  - `Automation Trigger / Hook`
- 让扩展注册的是 typed contract，而不是任意脚本

价值：

- 扩展性更强
- 主系统更稳
- 未来更容易做本地插件市场

### 9. Cron/计划任务应该是“一等 Agent 任务”，不是临时脚本

Hermes 的做法：

- cron 执行的是 agent task，不是简单 shell task
- 可挂技能、可投递到不同平台、可独立运行

对 RedBox 的借鉴：

- 你们已有 `scheduler`、`background`、`RedClaw` 长周期任务
- 但如果这些任务没有统一 agent contract，会越来越分裂

建议落地：

- 将定时任务统一到 `Agent Job` 模型
- Job 至少包含：
  - 目标
  - 可用 capability set
  - 附带 skill/context
  - 输出目标
  - 审批策略
  - 重试策略
- 区分“无记忆定时任务”和“继承会话上下文的持续任务”

价值：

- 自动化会真正可维护
- 更容易做日报、抓取、回顾、发布准备、知识整理

### 10. 子代理要做隔离执行，不只是“并发一下”

Hermes 的做法：

- delegation 支持隔离上下文、限制 toolset、控制是否能写共享记忆

对 RedBox 的借鉴：

- 你们如果要做多 agent，一开始就应带边界
- 否则并发会先把上下文污染和状态竞争放大

建议落地：

- 子代理任务协议至少包括：
  - 目标
  - 可访问工具
  - 可访问上下文
  - 是否允许写回 memory
  - 返回物格式
- 不要让子代理直接共享主代理全部状态

价值：

- 避免“多个 agent 一起把系统写乱”
- 更容易做审计与回放

## 三、长期最有战略价值的部分

### 11. 训练数据与评测闭环

Hermes 的做法：

- 批量跑 trajectory
- 支持 RL / environment / training format
- 压缩执行轨迹用于后续训练

对 RedBox 的借鉴：

- 如果你们想把系统从“能跑”做成“越来越懂你们业务”，这块长期很关键

建议落地：

- 保存结构化 trajectory：
  - 用户输入
  - 上下文快照摘要
  - 工具选择
  - 工具结果
  - 最终输出
  - 用户采纳/驳回
- 先用于评测和回放，不急着上 RL
- 建一套任务基准集，覆盖：
  - 内容生产
  - 素材整理
  - 发布准备
  - WeChat / sidecar / MCP 集成
  - 长任务恢复

价值：

- 长期能沉淀成你们自己的 agent benchmark 和调优数据

### 12. 用户模型不只是“偏好设置”

Hermes 的做法：

- 用户画像是系统的一等输入
- 会跨会话持续影响 agent 行为

对 RedBox 的借鉴：

- 你们不应只记录 API key、默认模型、UI 设置
- 应逐步形成“用户如何工作”的模型

建议落地：

- 用户画像可先从这些维度开始：
  - 喜欢的输出风格
  - 常用渠道
  - 风险偏好
  - 自动化容忍度
  - 默认审批策略
  - 常用工作流模板

价值：

- Agent 的行为会越来越稳定，不再每次重新适配用户

## 四、给 RedBox 的可执行清单

### P0：建议尽快做

- 建立统一 `Context Bundle` 装配层
- 将记忆分层为 `User / Workspace / Learnings`
- 给 session/tool result 建统一检索入口
- 给 agent 执行定义状态机与 checkpoint 恢复语义
- 把工具权限改为 `Capability Set`
- 给上下文文本、memory、外部输入增加注入扫描

### P1：建议作为下一阶段

- 抽出统一 `Agent Runtime Core`
- 让 scheduler/background 统一跑 `Agent Job`
- 明确 `Tool Provider / Memory Provider / Context Provider / Hook` 四类扩展面
- 为 skills 增加版本、风险等级、来源、自动触发策略
- 为子代理设计隔离协议

### P2：建议作为中长期战略

- 沉淀 trajectory 数据格式
- 建内部评测集与回放工具
- 建用户模型与工作流画像
- 探索“经验候选 -> skill 更新”的闭环，而不是直接让模型覆盖规则

## 五、不建议直接照搬的地方

### 1. 不要先做“大而全的多平台网关”

Hermes 的多平台消息入口很强，但对 RedBox 当前阶段不是最优先。

更合理的顺序：

- 先把桌面端 + daemon + scheduler 的核心 runtime 做干净
- 再考虑是否接更多外部入口

### 2. 不要先做“自我改写技能”

Hermes 强调 self-improving loop，这很先进，但也容易把系统稳定性打散。

RedBox 更稳妥的做法：

- 先做“经验候选”
- 人工或规则审核后再进入 skill

### 3. 不要让所有自动化默认拥有发布权限

RedBox 具备内容生产和外部平台接入能力，这意味着错误动作是有真实外部后果的。

建议：

- 发布、账号、文件写入、sidecar、MCP 凭据相关能力默认收紧

## 六、一个更贴近 RedBox 的目标架构

```text
User / Hook / Scheduler / Daemon
    -> Agent Runtime Core
        -> Context Bundle Assembly
        -> Capability Set Resolver
        -> Memory + Session Recall
        -> Skill Loader
        -> Tool Dispatcher
        -> Checkpoint / Trace / Approval
        -> Output Router
```

这个方向比“继续堆功能页”更重要，因为它决定你们的 AI 系统后面是变得更稳，还是变成大量特例逻辑。

## 参考来源

以下判断主要基于 Hermes Agent 官方仓库与官方文档：

- 仓库 README: <https://github.com/NousResearch/hermes-agent>
- 架构文档: <https://hermes-agent.nousresearch.com/docs/developer-guide/architecture/>
- Context Files: <https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files/>
- Persistent Memory: <https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/>
- Session Storage: <https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage/>
- Sessions: <https://hermes-agent.nousresearch.com/docs/user-guide/sessions/>
- Tools & Toolsets: <https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/>
- Security: <https://hermes-agent.nousresearch.com/docs/user-guide/security/>
- Features Overview: <https://hermes-agent.nousresearch.com/docs/user-guide/features/overview>
- Subagent Delegation: <https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation/>

