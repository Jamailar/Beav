# RedBox Desktop Agent Guide

`desktop/` 的执行规则。目标是保留桌面端必需的架构、工具、性能和文档约束，避免与根规则重复铺陈。

## Scope

- 本文件作用于 `desktop/`。
- 当前桌面端是 `Tauri v2 + React + Rust host`，不要按旧 Electron 假设写代码。
- 构建产物禁止手改：
  - `dist/`
  - `src-tauri/target/`
  - `src-tauri/gen/`
  - `release/`

## Key Paths

- Renderer：`src/main.tsx` -> `src/App.tsx` -> `src/pages/*` / `src/components/*`
- Bridge：`src/bridge/ipcRenderer.ts`
- Runtime UI：`src/runtime/*`
- Host：`src-tauri/src/main.rs` -> `src-tauri/src/commands/*`
- Runtime / AI：`src-tauri/src/runtime/*`、`agent/*`、`skills/*`、`tools/*`、`mcp/*`、`subagents/*`
- Persistence / workspace：`src-tauri/src/persistence/*`、`src-tauri/src/workspace_loaders.rs`
- Events：`src-tauri/src/events/*`
- Docs / assets：`docs/`、`prompts/`、`skills/`、`builtin-skills/`
- Agent 复盘日志：`~/Library/Application Support/RedBox/session-transcripts/`、`~/Library/Application Support/RedBox/session-bundles/`、`~/Library/Application Support/RedBox/` 下状态库

## Build And Verification

- `pnpm install`
- `pnpm build`
- `pnpm tauri:dev`
- `pnpm tauri:build`
- `pnpm ipc:inventory`
- `cd src-tauri && cargo fmt --check && cargo check`
- agent 流程复盘、tool 调用排查、会话状态异常分析时，默认先对照 `~/Library/Application Support/RedBox/` 下 transcript、bundle 和状态库，还原真实执行链路；不要只看渲染层现象或单点日志。

最低验证要求：

- 改页面：验证切换时首屏可立即渲染、旧数据保留、刷新失败不清空。
- 改 bridge / IPC / host command：至少从真实页面走一遍调用。
- 改 runtime / streaming / tool / prompt：至少跑一轮真实任务并检查事件流。
- 改 workspace / manuscripts / media / knowledge：验证当前工作区行为和持久化重载行为。

## Core Rules

- 先想清楚再改：不确定时明确假设；优先最简单可验证方案；改动保持外科手术式。
- 严格执行 Atomic Commits：一个提交只做一件事。
- 保持局部风格，不做无关重排。产品名统一用 `RedBox` / `redbox`，不要回引旧名。
- 不要硬编码 secrets、model key、endpoint 或机器相关路径。
- renderer 访问宿主统一走 `window.ipcRenderer`；不要在页面里散落裸 `invoke()` / `listen()`。
- `src-tauri/src/main.rs` 保持装配层；业务逻辑下沉到 `commands/*`、`runtime/*`、`persistence/*`、helper 模块。
- workspace / 文件 hydration 留在 persistence / loaders，不要复制到命令胶水层或 React 页面。
- 新事件从 `src-tauri/src/events/` 发，不要在命令里手搓兼容事件。
- 可见 UI 文案必须只服务用户决策、输入、状态或恢复动作；不要把设计 rationale、实现方式、内部模块名写进页面。

## AI And Tool Rules

- AI 路由优先级固定：
  1. skills / prompts 定义能力边界。
  2. structured metadata / typed payload / explicit mode 承载路由意图。
  3. runtime / tool 层负责校验和安全边界。
- 避免基于消息文本的关键词启发式；若必须约束，优先 typed state、explicit contract、runtime mode。
- 顶层工具面保持收敛：`bash`、`redbox_fs`、`app_cli`、`redbox_editor`。
- 新能力优先新增 canonical action，不新增新的顶层工具；文件类能力进 `redbox_fs`，宿主业务能力进 `app_cli`，编辑器原生协议只进 `redbox_editor`。
- `allowedTools`、skill 文本、prompt 资产只写 canonical tool 名和 canonical action；legacy alias 只允许运行时兼容层翻译，不作为新写法。
- tool pack 保持最小；普通 runtime 不应继承 diagnostics 的宽权限。
- Tool 设计最小原则：
  - Tool 是给 LLM 调用的结构化、可调用、单一职责函数，不是代理。
  - Single Responsibility：一个 tool 只做一件事；一个 action 只表达一个动作。
  - Deterministic：相同输入得到相同类型输出；不要依赖隐式状态，不要产生未声明副作用。
  - Schema-First：输入输出必须是严格 JSON 结构。
  - Clear Description：描述必须精确、互斥、无歧义，避免与其他 tool / action 重叠。
  - Composable：tool 应可被串联，不要把多步流程塞进黑盒。
  - Agent != Tool：tool 是 capability，agent 是 orchestration。
  - 禁止 God tool、隐式状态写入、含糊描述、功能重叠、非结构化输出、tool 调 agent 的嵌套黑盒。
  - 好 tool 的标准是 `small + predictable + structured + composable`；坏 tool 会让 agent 不稳定、不可控。

## State, Performance, And Lock Rules

- 默认 stale-while-revalidate：先渲染缓存/已有数据，再后台刷新。
- 页面/Tab 切换遵循 `render shell first, hydrate later`；首屏不可依赖慢 IPC。
- 刷新失败保留最后一次成功快照，内联报错，不清空 UI。
- 渲染端必须容忍部分或陈旧 payload；访问嵌套字段时提供 fallback。
- 全局锁必须窄且仅内存；不要持锁跨 `await`、磁盘 I/O、workspace 扫描、序列化或索引构建。
- 页面路径上的 host command 默认 `async`；CPU 重活进 `spawn_blocking`，不要把目录扫描、大文件读写、重序列化、媒体处理放进同步 page-load command。
- 首屏 IPC 只传 summary、ID、path、count、preview；详情按需懒取。
- 大列表、树、转录、时间线、富媒体初始化不要在首屏一次性做完；使用分页、虚拟化、延迟加载或分阶段 warmup。
- 页面切换工作必须可取消或可忽略；旧请求不能与最新导航竞争 UI 关键资源。
- 高频 UI 事件必须合批：`runtime:event` token/thought delta、CLI log、media job progress、drag/resize/mousemove、scroll 派生状态等，不允许逐事件直接触发大范围 `setState` / store notify / React commit。
- 事件订阅必须窄：页面和组件只订阅自己需要的 session、job、scope、event type 或 id 集合；不要因为方便直接订阅整张 `jobsById`、完整 runtime event stream、全量日志或全局 store 后再在 render/useMemo 中过滤。
- 外部 store selector 必须保持引用稳定：如果 selector 返回数组/对象，必须使用 equality、按 id 选择、分页或 patch 合并，避免无关对象变更导致全页面重渲染。
- Chat / runtime 流式内容更新必须保留 flush 边界：response end、cancel、error、clear session、view deactivate/unmount 都要先 flush pending chunk，防止为了降频而丢尾部内容。
- 媒体卡片和素材网格默认渲染轻量 poster/thumbnail；密集列表里不要直接挂大量 `<video>` 或原图，图片应按可视优先级使用 lazy/async decode，完整预览放到详情/overlay。
- 任何“流畅度优化”都必须先保护功能语义：不改 AI/runtime 协议、不吞事件、不跳过持久化、不改变任务状态机；优化应只减少无关渲染、无关订阅和主线程重活。

## Common Change Playbooks

- 新增 host 能力：先看消费页 -> 扩 `src/bridge/ipcRenderer.ts` -> 落到 `commands/*` / `runtime/*` / `persistence/*` -> 必要时补 `events/*`。
- 新增 runtime / streaming 流：优先统一 `runtime:event`，不要回退到消息文本解析。
- 新增页面 / Tab：在 `src/App.tsx` 接线，保持现有 lazy-loading / view-switching 习惯；切页期间保留上次成功状态。
- 新增 workspace 数据能力：扫描和 hydration 保持在 host persistence / loaders，React 页面只消费结果。

## Known Pitfalls

- 不要绕过 `src/bridge/ipcRenderer.ts`。
- 不要把 workspace / file hydration 放到 React hook 或 command handler。
- 不要让新页面首次渲染依赖 awaited activation-time IPC，这很容易导致“点 tab 就卡住”。
- 不要在 render 中直接解引用不稳定的嵌套宿主字段；旧持久化数据、部分迁移和陈旧 daemon 快照都可能缺字段。
- 不要把 WebView 当作 UI 卡顿的默认根因；先查 React commit、主线程 long task、IPC payload/event fanout、列表/媒体渲染、focus/visibility refresh 和 store 订阅面。
- 不要在 token/thought/log/progress 这类高频路径里每个事件都 `setMessages`、重建大数组、重跑 markdown parse 或刷新整页数据。
- 不要让一个 media job 更新唤醒所有媒体页面；media queue 真值可以集中，但 renderer 投影必须按 job id / owner / source / visible surface 收窄。
- 不要在拖拽、resize、mousemove 中同步写 localStorage、做 IPC、扫描数据或更新顶层 shell state；拖动中优先用 ref/CSS variable，结束时再提交 React state。
- 不要用“加 loading / 加说明文字 / 增加 UI 提示”掩盖卡顿；先做 stale-while-revalidate、合批、虚拟化、懒加载、缓存和后台化。
- 不要引入基于 ad hoc 字符串匹配的用户意图路由。
- 外部 URL / 平台 ID / 用户输入只要会落成 workspace 目录名或文件名，必须用 `storage_safe_file_stem` 这类 Windows-safe 规则；不要直接用 `slug_from_relative_path`。
- 不要把新逻辑继续堆进 `src-tauri/src/main.rs`，除非只是接线。
- agent 执行异常不要只截取表层报错；先去 `~/Library/Application Support/RedBox/` 联合检查 `session-transcripts/`、`session-bundles/` 和状态库，再判断是 prompt、runtime、tool 还是持久化问题。

## Documentation Expectations

- IPC 面变化后更新 `docs/ipc-inventory.md`，或运行 `pnpm ipc:inventory`。
- 大型 Rust 模块拆分/迁移后更新附近 `README.md` 或 `*.README.md`。
- 若某个 bug 沉淀出新的工程规则，把它写成窄且明确的规则或 pitfall，不要留在口头知识里。
