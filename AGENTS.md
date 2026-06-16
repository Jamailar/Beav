# RedBox / RedConvert Agent Guide

仓库级执行规则。目标是保留会影响安全性、架构边界、验证方式和文档维护的硬约束，避免重复 README。

## Scope And Priority

- 本文件作用于仓库根目录默认范围。
- 若子目录存在更近的 `AGENTS.md`，以更近文件为准。
- `desktop/` 是当前主产品；默认先检查这里。
- `archive/desktop-electron/` 是归档旧实现；除非任务明确涉及历史对照或迁移，不要默认修改。

## Environment And Surfaces

- Node 统一按 `>=22 <23` 处理；包管理按 `pnpm@10`。
- 打包、签名、远程 Windows 构建依赖本地/远程环境；未确认前提前不要随意调整发布脚本。
- 主要目录：
  - `desktop/`：主桌面端。
  - `Plugin/`：Chrome / Edge 扩展，负责把外部内容送入桌面端。
  - `RedBoxweb/`：官网 / 发布站点。
  - `private/scripts/hybrid-release/`：混合发布链路。
- 构建产物禁止手改：
  - `desktop/dist/`
  - `desktop/src-tauri/target/`
  - `desktop/src-tauri/gen/`
  - `desktop/release/`
  - `archive/desktop-electron/dist/`
  - `archive/desktop-electron/dist-electron/`
  - `archive/desktop-electron/release/`
- 关键文档位置：`README.md`、`private/Docs/`、`desktop/docs/`。

## Architecture Fast Map

- Renderer -> Host：`desktop/src/main.tsx` -> `desktop/src/App.tsx` -> `desktop/src/pages/*` -> `window.ipcRenderer` -> `desktop/src-tauri/src/main.rs` -> `commands/*` / `runtime/*` / `persistence/*`。
- AI runtime：`desktop/src-tauri/src/agent/*`、`runtime/*`、`skills/*`、`tools/*`、`mcp/*`、`subagents/*`。
- 数据流：
  - 插件采集：`Plugin/` -> 本地 HTTP / IPC -> 桌面端。
  - 知识库：`knowledge:*` IPC + store / 向量索引 / embedding。
  - 稿件/媒体：`manuscripts:*`、`media:*`、`cover:*`。
  - RedClaw：`redclaw:*` 及相关 store / scheduler / worker / daemon。

默认规则：

- renderer 不要散落调用 Tauri 原语；优先扩 `desktop/src/bridge/ipcRenderer.ts`。
- `main.rs` 保持装配/路由层；新逻辑优先下沉到 `commands/*`、`runtime/*`、`persistence/*` 或独立 service。
- AI 能力分流优先改 skills / prompts / tools 边界，不要在用户消息上硬写关键词判断。

## Verification

- 根目录不是完整 monorepo orchestrator；大多数命令都要进入具体子项目执行。
- `Plugin/` 是直接加载目录；改动后要在浏览器扩展管理页重新加载。
- agent 流程复盘、任务执行链路排查、会话异常分析时，默认先检查 `~/Library/Application Support/RedBox/`，重点看 `session-transcripts/`、`session-bundles/` 和状态库；不要只凭 UI 现象或零散控制台输出下结论。
- 最低验证矩阵：
  - 改 renderer 页面：验证页面切换、已有数据保留、刷新态。
  - 普通 renderer 页面改动不要默认启动浏览器 / Playwright / 模拟 Web 环境做检查；除非用户明确要求，优先用类型检查、静态检查和真实桌面端路径验证，避免把 Tauri 宿主环境缺失误判成页面问题。
  - 改 bridge / IPC / Tauri command：至少走一次真实 renderer 调用。
  - 改 AI runtime / tool / prompt：至少跑一轮真实任务，检查事件流、工具调用、权限确认、最终摘要。
  - 改 `Plugin/`：验证 popup、background、注入页或右键入口。
  - 改 `RedBoxweb/`：运行 `pnpm test` 和一次 `pnpm build`。

## Core Engineering Rules

- 保持现有文件风格；不要顺手重排无关代码。
- TypeScript / TSX 沿用当前风格；React 页面文件优先 `PascalCase`；IPC channel 保持现有域分组，如 `chat:*`、`runtime:*`、`knowledge:*`、`redclaw:*`。
- 这是 AI 系统，优先级固定为：
  1. `skills`、`prompts`、角色配置定义能力边界和决策原则。
  2. `structured metadata` / `typed payload` / `explicit runtime mode` 承载路由意图。
  3. `tool/runtime` 层负责输入校验、安全边界和执行约束。
- 不要为了修某个 agent 任务，把自然语言任务语义硬编码进宿主层、runtime、tool 执行器或 schema 分支；这会增强系统脆弱性并降低 agent 处理其他任务的能力。
- Agent 工作流优化只有两个方向：
  1. 给 agent 优化更好用的底层基座，让它更方便地获取信息、使用信息、理解工具和调用工具。
  2. 优化提示词、skills、activationHint、few-shot 示例和工具描述。
- 中间任务细节必须交给 agent 根据上下文自行判断；宿主层只提供通用能力、结构化上下文、安全边界和可组合工具，不替 agent 做面向具体任务的业务决策。
- 避免基于用户消息的硬编码关键词做意图路由；若必须约束，优先用 typed state、schema、tool contract、role spec、runtime mode。文本启发式只能是最后手段，且必须窄、显式、可移除。
- 禁止把 LLM 行为、技能选择、角色选择写成业务关键词硬编码。模型是否使用某个技能，必须由模型基于 skills catalog、activationHint、tool contract 和当前上下文自行决定；宿主层只能提供可调用能力、显式用户/页面传入的 typed intent，或已声明的 runtime mode，不得因为“电商套图/文章卡片/轮播图”等自然语言短语直接写入 `activeSkills` 或强制切换角色。
- 顶层工具面保持收敛：优先使用 `bash`、`redbox_fs`、`app_cli`、`redbox_editor`；新增能力优先扩 `action + payload`，不要按业务再拆新的顶层工具。

## Tool Design

- Tool 是给 LLM 调用的结构化、可调用、单一职责函数，不是代理。
- 单一职责：一个 tool 只表达一个能力；一个 action 只表达一个动作。
- 可预测：相同输入应得到相同类型的输出；不要依赖隐式状态，不要产生未声明副作用。
- schema-first：输入输出必须是严格 JSON 结构，不要把自由文本当协议。
- 描述必须精确、互斥、无歧义，避免与其他 tool / action 语义重叠。
- 设计上必须可组合，允许被其他 tool / action 串联，而不是把多步流程塞进一个黑盒。
- Agent 不等于 Tool：tool 是 capability，agent 是 orchestration。
- 禁止：
  - God tool / `do_everything`
  - 隐式状态写入或隐式 DB / store 修改
  - 含糊描述，如 “process data”
  - 功能重叠的多个 tool
  - 非结构化输出
  - tool 内部再调用 agent，形成嵌套黑盒
- 好 tool 的标准：small + predictable + structured + composable；坏 tool 会让 agent 变得不稳定、不可控。

## UX And State Rules

- 已有用户可见数据不能因刷新而被整页 loading 覆盖；默认使用 stale-while-revalidate。
- 刷新失败必须保留最后一次成功数据，并以内联错误提示代替清空页面。
- 常规操作优先图标化；不要给语义已足够清晰的控件补无意义说明文字。
- 全局状态锁必须窄且仅内存；不要在持锁期间做文件 I/O、目录扫描、workspace hydration、序列化、索引构建等慢操作。
- 固定模式：持锁读取最小快照 -> 释放锁 -> 锁外完成 I/O / workspace 操作 -> 重新持锁只应用最终内存变更。

## Rust Mutability And Lifetime Rules

- `mut` 只用于明确的状态变更边界；不要为绕过 borrow checker 到处加 `mut`、`.clone()`、`Arc<Mutex<_>>` 或全局缓存。
- `AppStore` 变更默认走 `with_store_mut` 等集中入口；闭包内只做内存级读写、校验和小对象组装，不做 await、进程等待、网络请求、文件扫描、索引构建、序列化或大文件写入。
- `with_store` / `with_store_mut` 闭包不要返回借用自 `AppStore` 的引用；需要跨闭包、跨 async、跨线程或跨 IPC 使用的数据必须转成 owned snapshot，如 `String`、`PathBuf`、`Vec<T>`、`serde_json::Value` 或 typed record。
- 后台任务、`tauri::async_runtime::spawn`、`spawn_blocking`、scheduler、media runtime、RedClaw runtime、AI turn、MCP / CLI 子进程管理，不允许捕获短生命周期引用；进入任务前先 clone 必需的 `AppHandle`、id、路径、payload 和配置快照。
- 不要把 `MutexGuard`、`&mut AppStore`、`&mut Value`、rusqlite statement/row、文件 handle 或子进程 handle 跨 await / thread / callback 保存；需要后续回写时，用 id + owned patch/result 重新获取锁并应用。
- 多把锁必须有稳定顺序，且锁内不得调用可能再拿 `store`、runtime state、`active_chat_requests`、`knowledge_index_state`、`media_generation_runtime` 的函数；无法证明无重入时，先释放当前锁。
- `Arc<Mutex<T>>` 只用于确实需要共享可变运行时状态的对象，如进程 handle、并发槽位、runtime lifecycle；普通业务数据优先 owned snapshot + event/result 回写。
- 生命周期声明优先让编译器推断；只有“返回值确实借用输入”时才手写 `'a`。不要用 `'static` 掩盖设计问题；跨任务数据应改成 owned，而不是强行延长引用生命周期。
- `serde_json::Value` 的 `&mut Value` 只适合局部 project/manifest/timeline patch；核心协议、持久化结构、AI/tool contract 和跨模块边界应优先 typed struct + schema 校验。
- 任何新增 Rust 状态或 runtime 字段，都要先回答：谁拥有数据、谁能修改、锁持有多久、是否跨 async/thread、失败时如何回滚、是否会阻塞 UI 或 AI 事件流。

## Known Pitfalls

- `desktop/src-tauri/src/main.rs` 仍然偏大；除接线外，新增逻辑优先拆到子模块。
- 插件问题不一定是插件本身，也可能是桌面端本地接入层未启动。
- 桌面端仍兼容 `window.ipcRenderer` 和一批旧 channel；改桥接或命令层时先确认兼容面。
- 调度逻辑使用本地时间；处理 daily / weekly / cron 时不要忽视时区和 DST。
- 不要把用户可见页面在刷新时清空成 loading 态。
- 不要在持锁范围内做慢 I/O。
- 不要为了修 Rust 编译错误把短生命周期数据塞进 `'static`、全局 `OnceLock` 或长期 `Arc<Mutex<_>>`；这通常会把编译期问题变成会话污染、内存泄漏或后台任务串线。
- 不要在 chat / RedClaw / media / knowledge 这类 runtime 路径里持锁等待子进程、ffmpeg、LLM、MCP server、文件系统或索引任务完成。
- agent 问题复盘不要跳过本地运行证据；默认去 `~/Library/Application Support/RedBox/` 对照 `session-transcripts/`、`session-bundles/` 和状态库还原实际执行链路。

## Documentation Expectations

- 新增或重构重要 IPC / bridge 能力时，更新对应 README / Docs。
- 新增重要提示词、技能、运行时模式、工具包时，在附近补最小文档，说明入口与职责。
- 如果某次 bug 修复沉淀出新的工程约束，优先把规则写回这里，要求窄、明确、可执行。
- 计划类文档默认放在最接近功能的 `docs/` 目录；桌面端优先放 `desktop/docs/`。
- 所有“计划 / 方案 / 路线图 / 改造计划”类 Markdown 文档都必须有 frontmatter，且至少包含：
  - `doc_type: plan`
  - `execution_status: not_started | in_progress | blocked | completed | cancelled`
  - `last_updated: YYYY-MM-DD`

## Working Style

- 先想清楚再动手：不确定时明确假设；存在多种解释时不要默选其一。
- 先选最简单可验证的实现；不要为未被要求的“灵活性”加抽象。
- 改动保持外科手术式；每一行改动都应直接服务于当前任务。
- 用可验证目标驱动执行：改完要有明确检查，而不是停在“理论上应该可行”。
- 严格执行 Atomic Commits：一个提交只做一件事。
