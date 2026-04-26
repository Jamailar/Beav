# RedBox Product Module Breakdown

Status: Current

## Scope

本文只覆盖当前仓库 `desktop/` 中已经存在的实现，不推测旧 `archive/desktop-electron/` 或外部服务的隐藏逻辑。

本文目标不是做 roadmap，而是回答四件事：

1. 当前产品到底由哪些功能模块组成
2. 每个模块在 renderer / bridge / host / persistence 各落在哪里
3. 哪些能力必须依赖成熟库，哪些能力应该继续自研
4. 当前架构下最关键的性能策略和后续推荐演进方向是什么

## Snapshot

- 前端主入口：`src/main.tsx` -> `src/App.tsx`
- 宿主主入口：`src-tauri/src/main.rs`
- 当前页面文件：16 个 `src/pages/*.tsx`
- 前端组件文件：64 个 `src/components/**`
- Host command 模块：33 个 `src-tauri/src/commands/*.rs`
- Runtime 模块：10 个 `src-tauri/src/runtime/*`
- Tool 模块：12 个 `src-tauri/src/tools/*`
- Skill 模块：14 个 `src-tauri/src/skills/*`
- Prompt Library 文件：103 个 `prompts/library/**`
- 官方市场包目录：10 个 `redbox-market/packages/official/*`

## 1. Layered Architecture

| Layer | Main Paths | Responsibility | 现成库 / 平台 | 自研重点 |
| --- | --- | --- | --- | --- |
| App Shell | `src/App.tsx`, `src/components/Layout.tsx` | 页面切换、空间切换、懒加载、全局对话框、首次引导 | React, Suspense, Lucide | 视图缓存策略、跨页 pending message、剪贴板采集、stale-while-revalidate |
| Renderer Pages | `src/pages/*`, `src/components/*`, `src/features/*` | 用户可见业务界面 | React, clsx, Radix UI, CodeMirror, XYFlow, Wavesurfer | 页面编排、局部状态机、Host 能力消费、交互约束 |
| IPC Bridge | `src/bridge/ipcRenderer.ts`, `src/runtime/runtimeEventStream.ts` | channel -> command 映射、guarded invoke、事件归一化、fallback | Tauri API | 类型化桥接、超时/降级、兼容事件收敛 |
| Host Command Surface | `src-tauri/src/commands/*`, `src-tauri/src/main.rs` | 接收 renderer 请求并路由到 runtime / persistence / services | Tauri v2 | 业务域拆分、最小 payload、异步化、状态快照读取 |
| Runtime Core | `src-tauri/src/runtime/*`, `src-tauri/src/events/*`, `src-tauri/src/agent/*`, `src-tauri/src/subagents/*` | session/task/runtime/tool/checkpoint/child-runtime | OpenAI-compatible transport, serde | runtime 模式、事件协议、工具执行边界、任务恢复与 lineage |
| Persistence / Workspace | `src-tauri/src/persistence/*`, `src-tauri/src/workspace_loaders.rs` | 本地状态持久化、工作区 hydrate、session artifact 拆分 | 文件系统、serde_json | store 瘦身、慢 I/O 与锁分离、workspace schema |
| Knowledge / Index | `src-tauri/src/knowledge_index/*`, `src-tauri/src/commands/library.rs` | 知识目录、指纹、索引、重建、监听 | 文件监听、向量能力由外部模型提供 | catalog schema、增量重建、最小状态摘要 |
| Media / Video Pipeline | `src/components/manuscripts/*`, `src/features/video-editor/*`, `src/remotion/*`, `remotion/render.mjs`, `src/vendor/freecut/*` | 稿件、时间线、视频编辑、预览、导出 | Remotion, mediabunny, idb, vendored FreeCut | 编辑协议、轨道/片段状态、自定义桥接、导出编排 |
| AI Assets | `prompts/*`, `builtin-skills/*`, `skills/*`, `redbox-market/*` | prompt、skill、模板、官方包 | Markdown/YAML/JSON | runtime mode 资产、权限、包结构、市场接入 |

## 2. Product Surface Map

### 2.1 当前主导航页面

这些页面由 `src/App.tsx` 懒加载并作为当前主产品表面：

| View Key | Page File | 当前定位 |
| --- | --- | --- |
| `chat` | `src/pages/Chat.tsx` | 通用 AI 聊天与工具执行 |
| `team` | `src/pages/Team.tsx` | 多成员协作入口，内含顾问与群聊 |
| `skills` | `src/pages/Skills.tsx` | 技能浏览、创建、编辑、启停 |
| `knowledge` | `src/pages/Knowledge.tsx` | 知识采集、目录浏览、转写、相似度检索 |
| `settings` | `src/pages/Settings.tsx` | 配置、诊断、MCP、daemon、任务、工具观测 |
| `manuscripts` | `src/pages/Manuscripts.tsx` | 写作、富文稿、视频稿、音频稿、导出 |
| `archives` | `src/pages/Archives.tsx` | 创作档案与样本库 |
| `wander` | `src/pages/Wander.tsx` | 随机素材联想与选题方向生成 |
| `redclaw` | `src/pages/RedClaw.tsx` | 自动化创作、长周期任务、技能运营台 |
| `media-library` | `src/pages/MediaLibrary.tsx` | 素材库、图片生成、视频生成、素材绑定 |
| `cover-studio` | `src/pages/CoverStudio.tsx` | 封面模板、封面生成、封面资产管理 |
| `subjects` | `src/pages/Subjects.tsx` | 人物/主体资料、属性、图片、声音样本 |
| `workboard` | `src/pages/Workboard.tsx` | 工作项看板与自动化任务执行视图 |

### 2.2 当前存在但未直接挂到主导航的页面

| Page File | 当前角色 |
| --- | --- |
| `src/pages/Advisors.tsx` | `Team` 内嵌的成员管理主面板 |
| `src/pages/CreativeChat.tsx` | `Team` 内嵌的群聊房间执行面板 |
| `src/pages/ImageGen.tsx` | 独立生图页，当前更多被 `MediaLibrary` 吸收 |

## 3. Core Infrastructure Modules

### 3.1 App Shell And Navigation

**入口文件**

- `src/main.tsx`
- `src/App.tsx`
- `src/components/Layout.tsx`
- `src/components/AppDialogsHost.tsx`
- `src/components/FirstRunTour.tsx`
- `src/components/StartupMigrationModal.tsx`

**职责拆解**

- 负责全局视图切换和 lazy page mount。
- 管理全局 pending message：把剪贴板、知识页、漫步页、RedClaw 产生的任务转成聊天上下文。
- 承载空间切换、更新提示、首次启动迁移提示。
- 通过 `Layout` 统一左侧导航与全局空间栏。

**实现方式**

- 页面全部通过 `React.lazy` + `Suspense` 按需加载。
- `App.tsx` 维护 `currentView`、`pendingChatMessage`、`pendingRedClawMessage`、`pendingManuscriptFile`。
- 剪贴板轮询里内建 YouTube URL 识别，允许从系统剪贴板直接发起知识采集。
- 官方账号状态、迁移状态、全局对话框都挂在 shell 层，而不是散落到各页。

**必须用现成库**

- React/Suspense 用于懒加载和状态驱动 UI。
- Lucide 用于统一图标。

**必须继续自研**

- 视图切换的缓存/非缓存策略。
- 跨页面消息传递模型。
- 剪贴板候选识别和启动迁移流程。

**性能策略**

- 页面默认懒加载，首屏不一次性打满所有业务面。
- 当前 `NON_CACHEABLE_VIEWS` 全部关闭了页面缓存，减少状态漂移；代价是切回页面时要重新 hydrate。
- 所有慢数据不在路由切换前阻塞，页面先显示 shell，再后台加载。

### 3.2 IPC Bridge And Event Stream

**入口文件**

- `src/bridge/ipcRenderer.ts`
- `src/runtime/runtimeEventStream.ts`

**职责拆解**

- 把前端调用统一收敛到 `window.ipcRenderer`。
- 对部分 channel 做显式 command 映射，例如 `spaces:list` -> `spaces_list`。
- 提供 `invokeGuarded()` / `invokeCommandGuarded()` 超时与 fallback。
- 统一监听 `runtime:event`，兼容老的 `chat:*` / `creative-chat:*`。

**实现方式**

- `ipcRenderer.ts` 对不同 channel 提供默认兜底返回值，避免页面因 host 暂时不可用而整体炸掉。
- `channelListeners` 维护注册/反注册，避免 Tauri listener 泄漏。
- `runtimeEventStream.ts` 根据 `sessionId`、`taskId`、`runtimeId` 做前端分发过滤。

**必须用现成库**

- `@tauri-apps/api/core` 和 `@tauri-apps/api/event`。

**必须继续自研**

- channel 兼容层。
- guarded invoke 的 normalize / timeout / fallback 策略。
- runtime 事件归一化协议。

**推荐方向**

- 保持“桥接层集中 + 页面只消费 typed helper”这条路线，不要退回到每个页面直接写裸 `invoke()`。
- 相比“自动生成一整套硬编码 client”，当前桥接层更适合这个仍在快速迁移中的仓库；推荐继续在桥里增量类型化，而不是一次性 codegen 全量替换。

### 3.3 Host Composition And App State

**入口文件**

- `src-tauri/src/main.rs`
- `src-tauri/src/app_shared.rs`

**职责拆解**

- 装配全局状态 `AppState`。
- 注册顶层 `ipc_invoke` / `ipc_send` 以及一组直接暴露的 Tauri command。
- 启动时恢复知识索引、认证、RedClaw runtime、assistant daemon、skill catalog、runtime warmup。

**实现方式**

- `main.rs` 当前仍然很大，但总体角色是 assembly layer。
- `AppState` 中集中持有 store、runtime、diagnostics、knowledge index、skill watcher 等内存态。
- `setup()` 阶段执行 runtime restore，而不是让页面首次打开时才触发所有后台子系统自举。

**必须用现成库**

- Tauri v2 app lifecycle。
- Rust 标准库并发原语。

**必须继续自研**

- 全局状态结构。
- 启动恢复顺序。
- 各命令域与 runtime/service 的装配关系。

**性能策略**

- 重初始化任务放在 `setup()` 后台阶段完成，避免页面路径首开时触发冷启动雪崩。
- 高体积会话产物拆到 `session-artifacts/`，避免主状态文件膨胀。

### 3.4 Persistence And Workspace Hydration

**入口文件**

- `src-tauri/src/persistence/mod.rs`
- `src-tauri/src/workspace_loaders.rs`
- `docs/contracts/workspace-schema.md`

**职责拆解**

- 管理 `AppStore` 的读写。
- 把工作区中的稿件、知识、媒体、主题等文件 hydrate 进内存状态。
- 负责老快照向 `session-artifacts/` 拆分迁移。

**实现方式**

- 通过 `with_store` / `with_store_mut` 读写主 store。
- 慢文件 I/O 下沉到 persistence/loaders，不允许页面或 command 层自己扫目录。
- 主快照只保留“当前必要状态”，会话 transcript/checkpoint/tool results 单独文件化。

**必须用现成库**

- Rust 文件系统和 serde。

**必须继续自研**

- 工作区 schema。
- hydrate 策略。
- state slimming 和迁移。

**性能策略**

- 锁只保护内存快照，不包住磁盘 I/O。
- 页面激活时优先读最小快照，详细数据后台 hydrate。

## 4. AI Runtime And Automation Modules

### 4.1 Session / Task / Runtime Core

**入口文件**

- `src-tauri/src/runtime/config_runtime.rs`
- `src-tauri/src/runtime/interactive_loop.rs`
- `src-tauri/src/runtime/session_runtime.rs`
- `src-tauri/src/runtime/task_runtime.rs`
- `src-tauri/src/runtime/orchestration_runtime.rs`
- `src-tauri/src/runtime/agent_engine.rs`
- `src-tauri/src/runtime/events.rs`

**职责拆解**

- 把一次对话、一次任务、一次子任务拆成不同层级的 runtime record。
- 管理流式响应、工具调用、checkpoint、resume、fork、compact。
- 支撑 `chat`、`wander`、`redclaw`、后台任务等不同运行模式。

**实现方式**

- 会话维度与任务维度分开存储，避免把所有状态塞进聊天消息。
- runtime 事件统一从 `src-tauri/src/events/mod.rs` 发出。
- query/session/task/orchestration 通过 `commands/runtime_*` 和 `commands/chat_*` 暴露给 UI。

**必须用现成库**

- LLM transport 走 OpenAI-compatible API。
- serde/JSON 负责 typed payload。

**必须继续自研**

- runtime mode 设计。
- session lineage / checkpoint / tool result persistence。
- 恢复、继续执行、子任务聚合逻辑。

**推荐方向**

- 当前“typed runtime + event stream + task/session 分层”明显优于“只用聊天消息记录一切”。
- 不推荐回退到关键词启发式路由；推荐继续沿 `contextType`、`runtimeMode`、`tool pack`、`skill contract` 做显式编排。

### 4.2 Tool Registry, Guard And Execution

**入口文件**

- `src-tauri/src/tools/catalog.rs`
- `src-tauri/src/tools/registry.rs`
- `src-tauri/src/tools/packs.rs`
- `src-tauri/src/tools/guards.rs`
- `src-tauri/src/tools/executor.rs`
- `src-tauri/src/tools/app_cli.rs`
- `src-tauri/src/tools/bash.rs`
- `src-tauri/src/tools/workspace_search.rs`
- `src-tauri/src/tools/knowledge_search.rs`

**职责拆解**

- 定义 canonical top-level tools。
- 给不同 runtime mode 分配 tool pack。
- 在执行前做 capability guard、approval、结果截断。

**实现方式**

- 当前治理目标是把工具面收敛到 `bash`、`redbox_fs`、`app_cli`、`redbox_editor` 四个 canonical tool。
- 兼容层 `compat.rs` 只翻译旧别名，不承载新产品语义。
- Prompt/skill 不再直接引用大量零散工具名，而是消费 registry 输出。

**必须用现成库**

- OpenAI tool schema 兼容格式。

**必须继续自研**

- capability guard。
- pack 分配。
- canonical action 设计。

**性能策略**

- 结果 budget 截断，减少大结果污染上下文。
- tool pack 最小化，避免 runtime 默认暴露过宽工具面。

### 4.3 Skills Runtime

**入口文件**

- `src-tauri/src/skills/loader.rs`
- `src-tauri/src/skills/permissions.rs`
- `src-tauri/src/skills/runtime.rs`
- `src-tauri/src/skills/executor.rs`
- `src-tauri/src/skills/watcher.rs`
- `src-tauri/src/skills/catalog.rs`
- `builtin-skills/`
- `skills/`
- `docs/skill-runtime-v2.md`

**职责拆解**

- 发现、加载、监听、权限校验、运行时接入技能。
- 支撑内置技能、用户技能、空间技能多来源并存。

**实现方式**

- `Skills.tsx` 负责浏览/编辑/启停。
- `RedClaw.tsx` 会把 skills 作为可运营能力直接启停和安装。
- watcher 负责技能文件变化同步。

**必须用现成库**

- 文件监听。
- Markdown 文本技能格式。

**必须继续自研**

- 技能权限模型。
- 多来源合并规则。
- 运行时注入契约。

### 4.4 MCP Runtime

**入口文件**

- `src-tauri/src/mcp/manager.rs`
- `src-tauri/src/mcp/session.rs`
- `src-tauri/src/mcp/transport.rs`
- `src-tauri/src/mcp/resources.rs`
- `src-tauri/src/commands/mcp_tools.rs`

**职责拆解**

- 管理 MCP server 配置、连接、会话、资源访问和 probe。
- 给 Settings 中的 MCP 配置面板提供统一后端。

**实现方式**

- manager 统一管 lifecycle。
- transport 处理 stdio / 本地配置发现等 transport 级问题。
- session 维护连接状态。
- resource 层负责资源读取结果的结构化包装。

**必须用现成库**

- MCP 协议本身。

**必须继续自研**

- 本地配置发现。
- 连接生命周期。
- 结果结构稳定性。

**推荐方向**

- 当前单一 MCP manager 方案优于“每个业务域私起一个 client”。
- 推荐继续保持 manager/session/transport/resources 四层拆分。

### 4.5 Scheduler, RedClaw Runtime And Background Jobs

**入口文件**

- `src-tauri/src/scheduler/*`
- `src-tauri/src/commands/redclaw.rs`
- `src-tauri/src/commands/redclaw_runtime.rs`
- `src/pages/RedClaw.tsx`
- `src/pages/Workboard.tsx`

**职责拆解**

- 管理 scheduled task、long-cycle task、runner status、heartbeat。
- 允许手动触发、自动轮询、后台执行、结果回投主会话。

**实现方式**

- `RedClaw.tsx` 提供 task 配置、skill 安装、runner 控制、上下文会话切换。
- `Workboard.tsx` 提供执行中/等待中/完成等看板视角。
- Host 侧 scheduler 负责 lease、heartbeat、retry、dead-letter。

**必须用现成库**

- Rust 后台任务和时间调度基础能力。

**必须继续自研**

- 内容自动化业务模型。
- 任务元数据结构。
- 主会话与自动化会话的关联。

**推荐方向**

- 当前 host-side scheduler 明显优于 renderer timer。
- 不推荐把定时任务退回到前端 `setInterval`；那样会引入窗口关闭即停、状态不一致和权限边界混乱的问题。

## 5. Knowledge And Content Pipeline Modules

### 5.1 Knowledge Library

**入口文件**

- `src/pages/Knowledge.tsx`
- `src/components/KnowledgeChatModal.tsx`
- `src-tauri/src/commands/library.rs`
- `src-tauri/src/commands/embeddings.rs`

**职责拆解**

- 展示红书笔记、视频、YouTube、文档知识源。
- 支持分页目录、详情查询、删除、转写、文档源添加、YouTube 摘要重建。
- 可把知识项一键送入聊天或 RedClaw 创作流程。

**实现方式**

- 前端主列表已经切到 `knowledge:list-page` 目录摘要模式，而不是一次拉全量细节。
- 文档知识源用 `DocumentKnowledgeSource`，视频和笔记用 catalog summary 归一化。
- 支持 embedding cache 和 similarity cache，用于稿件参考内容的知识相似度排序。

**必须用现成库**

- `react-markdown` + `remark-gfm` 用于知识内容预览。
- embedding 依赖外部模型接口。

**必须继续自研**

- catalog summary schema。
- 知识项归一化。
- 相似度缓存策略。

**性能策略**

- 优先分页目录摘要，详情按需获取。
- 知识索引状态单独拉取，不把索引明细塞进首屏 payload。
- 相似度结果做缓存，减少重复 embedding 计算。

### 5.2 Knowledge Index Runtime

**入口文件**

- `src-tauri/src/knowledge_index/schema.rs`
- `src-tauri/src/knowledge_index/catalog.rs`
- `src-tauri/src/knowledge_index/indexer.rs`
- `src-tauri/src/knowledge_index/jobs.rs`
- `src-tauri/src/knowledge_index/watcher.rs`
- `src-tauri/src/knowledge_index/fingerprint.rs`

**职责拆解**

- 把工作区知识资产建成可查询目录和索引。
- 追踪变更、计算指纹、后台增量重建、监听目录变化。

**实现方式**

- 索引运行时状态放内存，持久索引数据放 `.redbox/index/`。
- 页面只拿最小 status 摘要：indexed/pending/failed/lastError/isBuilding。
- rebuild 和 watcher 不能卡页面路径。

**必须用现成库**

- 文件监听能力。

**必须继续自研**

- fingerprint 规则。
- rebuild job orchestration。
- catalog schema。

### 5.3 Manuscript Workspace

**入口文件**

- `src/pages/Manuscripts.tsx`
- `src/components/manuscripts/*`
- `shared/manuscriptFiles.ts`
- `src-tauri/src/commands/manuscripts.rs`
- `src-tauri/src/manuscript_package.rs`

**职责拆解**

- 管理长文稿、富文稿、视频稿、音频稿。
- 文件树浏览、创建、重命名、删除、读写保存。
- 富文稿分页、主题、导出。
- 视频/音频 package 状态、AI 写作提案、脚本确认、外部素材绑定。

**实现方式**

- `Manuscripts.tsx` 同时承担文件管理器和工作台入口。
- 不同稿件类型分别懒加载 `WritingDraftWorkbench`、`AudioDraftWorkbench`、`ExperimentalVideoWorkbench`。
- 支持 AI 写作提案：`manuscripts:get-write-proposal` / accept / reject。
- 支持图文稿预览图生成、富文稿 HTML 渲染、Remotion 场景生成与导出。

**必须用现成库**

- Markdown/CodeMirror 编辑相关库。
- HTML 转图片库用于富文稿预览图。

**必须继续自研**

- 稿件包协议。
- 富文稿分页稳定器。
- AI 写作提案接受/拒绝流程。
- 编辑器运行态与 package state 同步。

**性能策略**

- 文件树与媒体列表分开刷新。
- 首屏只加载当前文件和必要目录摘要。
- 大型视频编辑状态拆到子组件与 store，不让整个 `Manuscripts.tsx` 反复重渲染。

### 5.4 Video Editor, Timeline And Export Pipeline

**入口文件**

- `src/components/manuscripts/VideoDraftWorkbench.tsx`
- `src/components/manuscripts/EditableTrackTimeline.tsx`
- `src/components/manuscripts/VendoredFreecutTimeline.tsx`
- `src/components/manuscripts/freecutTimelineBridge.ts`
- `src/features/video-editor/store/useVideoEditorStore.ts`
- `src/remotion/Root.tsx`
- `remotion/render.mjs`
- `src/vendor/freecut/**`

**职责拆解**

- 轨道编辑、片段拆分、文本/字幕插入、轨道增删改、播放头操作。
- 预览状态、scene 状态、timeline 状态、selection 状态统一管理。
- Remotion 预览与最终导出。

**实现方式**

- UI 层采用 vendored FreeCut timeline，不直接 fork 到完全自写编辑器。
- RedBox 通过 `freecutTimelineBridge.ts` 和 `editorProject.ts` 把自家 package 协议接到 FreeCut 组件上。
- store 统一承载 project/assets/timeline/player/scene/panels/remotion/script/editor。
- Host 提供 `manuscripts:add-package-clip`、`split-package-clip`、`update-package-clip`、`transcribe-package-subtitles`、`render-remotion-video` 等原子命令。

**必须用现成库**

- Remotion：视频 composition 与最终渲染。
- mediabunny：媒体输入处理。
- idb：浏览器侧缓存。
- vendored FreeCut：复杂时间线 UI 和交互基底。
- Wavesurfer / worker：波形与预览缓存。

**必须继续自研**

- RedBox package schema。
- FreeCut <-> RedBox 协议桥。
- 场景、轨道、字幕、文本的业务语义。
- 编辑器 runtime state 持久化和 undo/redo 语义。

**方案比较**

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 纯自研 React 时间线 | 业务自由度最高 | 交互复杂度和维护成本极高 | 不推荐作为主路线 |
| 直接嵌第三方编辑器黑盒 | 开发快 | 无法深度绑定稿件协议和 AI 生成流程 | 不推荐 |
| 当前 vendored FreeCut + 自研桥接 + Remotion 导出 | 在可控性和速度间平衡最好 | 需要维护 vendor 差异和桥接层 | 推荐继续沿用 |

**性能策略**

- 波形、胶片条、GIF 帧走 worker / IndexedDB / memory cache。
- 页面级不一次渲染所有片段详情，按可见区和 playhead 附近处理。
- Host 命令粒度保持原子，避免一次传整个大型 timeline blob 来回抖动。

### 5.5 Media Library

**入口文件**

- `src/pages/MediaLibrary.tsx`
- `src/pages/media-library/MediaAssetPreviewOverlay.tsx`
- `src-tauri/src/commands/generation.rs`
- `src-tauri/src/commands/manuscripts.rs`

**职责拆解**

- 展示已生成、计划项、导入素材。
- 支持图片生成、视频生成、绑定到稿件、删除、打开目录。

**实现方式**

- 页面同时读取 `media:list` 和 `manuscripts:list`，用于素材与稿件绑定。
- 图片/视频生成与素材管理合并在同一工作台，不再完全分散成独立页面。
- 支持参考图、视频生成模式、多种 provider/template 参数。

**必须用现成库**

- 浏览器文件读取 API。

**必须继续自研**

- 资产元数据模型。
- 稿件绑定流程。
- 生成任务和媒体库的一体化交互。

### 5.6 Cover Studio

**入口文件**

- `src/pages/CoverStudio.tsx`
- `src-tauri/src/commands/generation.rs`
- `src-tauri/src/commands/manuscripts/theme/*`

**职责拆解**

- 管理封面模板、标题构成、prompt switch、封面生成历史。
- 允许导入 legacy 模板并生成封面资产。

**实现方式**

- 模板保存在本地空间级存储键中。
- 生成支持标题模式和 prompt 模式。
- 模板可学习字体、色调、美颜、替换背景等 prompt switch。

**必须用现成库**

- 图像生成仍依赖外部模型 API。

**必须继续自研**

- 模板结构。
- 标题到 prompt 的转换规则。
- 模板导入/迁移逻辑。

### 5.7 Subjects

**入口文件**

- `src/pages/Subjects.tsx`
- `src-tauri/src/commands/subjects.rs`

**职责拆解**

- 维护人物/主体分类、属性、标签、参考图、声音样本。
- 提供创作所需的主体资料库。

**实现方式**

- 分类和主体记录都在 host 侧持久化。
- 前端支持录音、图片上传、属性编辑和筛选搜索。
- `SubjectRecord` 包含 `previewUrls`、`voicePreviewUrl` 等可直接渲染字段。

**必须用现成库**

- 浏览器录音/音频元数据能力。

**必须继续自研**

- 主体档案 schema。
- 分类-主体关系。
- 参考音色与创作流程的对接语义。

### 5.8 Archives

**入口文件**

- `src/pages/Archives.tsx`

**职责拆解**

- 管理档案 profile 与样本集合。
- 为后续 AI 创作、角色学习或样例库提供结构化素材。

**实现方式**

- 页面通过 `archives:*` 和 `archives:samples:*` 一组 channel 工作。
- 支持 profile CRUD 和 sample CRUD。

**备注**

- 这是当前已实现但相对独立的内容资产面，和 `Knowledge`、`Subjects`、`Manuscripts` 共同构成内容资产体系。

## 6. Collaboration, Ideation And Team Modules

### 6.1 Chat

**入口文件**

- `src/pages/Chat.tsx`
- `src/components/ChatComposer.tsx`
- `src/components/MessageItem.tsx`
- `src/components/ToolConfirmDialog.tsx`

**职责拆解**

- 会话列表、消息流、工具确认、附件上传、音频转写。
- 固定上下文会话、诊断会话、上下文压缩状态展示。

**实现方式**

- 通过 `chat:get-sessions`、`chat:get-messages`、`chat:get-runtime-state`、`chat:send`、`chat:cancel` 等命令工作。
- 订阅 runtime event stream，把 thinking、tool、response chunk 合并成 UI 消息。
- 内建 fixed session warm snapshot，避免固定上下文会话反复冷加载。

**必须用现成库**

- React 渲染。
- 文件上传与 blob 处理能力。

**必须继续自研**

- 流式消息合并。
- tool event -> message/process timeline 的映射。
- context usage / compact rounds 可视化。

**性能策略**

- chunk 去重和节流。
- 自动滚动只在用户接近底部时触发。
- 会话消息与 runtime state 分步加载。

### 6.2 Team / Advisors / Creative Chat

**入口文件**

- `src/pages/Team.tsx`
- `src/pages/Advisors.tsx`
- `src/pages/CreativeChat.tsx`
- `src-tauri/src/commands/advisor_ops.rs`
- `src-tauri/src/commands/chatrooms.rs`

**职责拆解**

- 团队页把“成员”和“群聊房间”收在同一工作台。
- Advisors 负责顾问人设、头像、prompt、知识文件、persona 生成、会话历史。
- CreativeChat 负责多顾问群聊房间、群消息流和附件。

**实现方式**

- `Team.tsx` 负责左侧编排，不重新发明独立导航系统。
- 顾问创建支持 `manual`、`template`、`youtube` 三种模式。
- 群聊房间与顾问列表在进入 Team 时并行加载。

**必须用现成库**

- React 组件组合。

**必须继续自研**

- 顾问 profile schema。
- 群聊房间协议。
- 多顾问上下文注入与 persona 生成流程。

### 6.3 Wander

**入口文件**

- `src/pages/Wander.tsx`
- `src/components/wander/WanderLoadingDice.tsx`
- `src-tauri/src/commands/chat_sessions_wander.rs`

**职责拆解**

- 随机取材、生成内容方向、记录历史、将灵感转成稿件或 RedClaw 任务。

**实现方式**

- 通过 `wander:get-random` 拉取材料。
- `wander:brainstorm` 走后台 send，然后靠 `wander:progress`、`wander:result` 事件驱动 UI。
- 结果支持多方案切换和结构化校验。

**必须用现成库**

- 无强依赖第三方复杂库，属于纯业务交互面。

**必须继续自研**

- 灵感结果结构。
- 进度卡片协议。
- 与 RedClaw/Manuscripts 的跳转绑定。

## 7. Operations, Config And External Integration Modules

### 7.1 Settings And Diagnostics

**入口文件**

- `src/pages/Settings.tsx`
- `src/pages/settings/SettingsSections.tsx`
- `src/pages/settings/shared.tsx`
- `src/features/official/generatedOfficialAiPanel.tsx`

**职责拆解**

- 通用设置、AI 源配置、MCP 管理、runtime 诊断、任务和 session 观测。
- assistant daemon 配置。
- Weixin/relay/feishu 等外部入口配置。
- browser plugin 状态、yt-dlp 安装、日志目录等系统运维能力。

**实现方式**

- 页面是当前最大的“运维控制台”。
- 对 runtime perf、background tasks、worker pool、task trace、session transcript、MCP oauth status 都有直接面板。ToolRouter / tool plan 属于底层日志与 checkpoint 审计信息，不进入用户可见设置面板。
- 官方能力面板动态加载，避免普通场景下强耦合。

**必须用现成库**

- React UI 基础库。

**必须继续自研**

- AI source 配置模型。
- 诊断数据聚合与展示。
- daemon / relay / weixin sidecar 配置模型。

**性能策略**

- 面板按 tab 和 request id 分步加载。
- 保留本地快照，避免每次切入 settings 全量清空。

### 7.2 Official / WeChat / Plugin / System Integrations

**入口文件**

- `src-tauri/src/commands/official.rs`
- `src-tauri/src/commands/wechat_official.rs`
- `src-tauri/src/commands/plugin.rs`
- `src-tauri/src/commands/system.rs`
- `src-tauri/src/official_support.rs`
- `src-tauri/src/auth.rs`

**职责拆解**

- 官方账号登录态与能力面板。
- 微信公众号绑定、草稿流、本地 sidecar 登录。
- 浏览器扩展导出和目录打开。
- 系统级打开路径、剪贴板、更新检查等。

**实现方式**

- 官方能力通过独立 front-end feature + host auth runtime 实现。
- plugin 依赖本地目录准备和导出。
- wechat official 同时包含 binding 和 sidecar relay 路线。

**必须用现成库**

- 第三方平台 API。
- 本机系统能力。

**必须继续自研**

- 账号状态同步。
- 本地 binding / relay 模型。
- 插件打包与导出流程。

### 7.3 Assistant Daemon

**入口文件**

- `src-tauri/src/commands/assistant_daemon.rs`
- `src/pages/Settings.tsx`

**职责拆解**

- 让 RedBox 的 AI/runtime 能从桌面 UI 外部被 webhook、sidecar 或消息通道唤醒。

**实现方式**

- 在 Settings 中配置 host/port、feishu、relay、weixin。
- 启动时可选择 autoStart 和 keepAliveWhenNoWindow。

**推荐方向**

- 继续把 daemon 视作宿主级服务，不要迁回 renderer 驱动。

## 8. Which Parts Must Use Libraries vs Must Stay Custom

### 8.1 必须坚定使用成熟库/平台的部分

- 桌面宿主：Tauri v2。没有必要自研窗口系统或系统桥。
- 视频合成与渲染：Remotion。自研渲染器成本远高于收益。
- 时间线交互底盘：vendored FreeCut。复杂轨道编辑不值得从零写起。
- 媒体解码/处理：mediabunny、wavesurfer、浏览器媒体能力。
- 浏览器端缓存：IndexedDB + `idb`。
- 通用 UI primitives：Radix UI。
- 富文本/代码编辑：CodeMirror。
- 向量/图像/视频生成：外部模型 API，不自研模型层。

### 8.2 必须继续自研的部分

- `window.ipcRenderer` 兼容桥和 guarded invoke 语义。
- runtime mode、tool pack、skill permission、MCP 接入治理。
- 稿件 package schema、富文稿分页、Remotion 场景协议。
- RedClaw 自动化业务模型和 workboard 状态模型。
- 知识 catalog、fingerprint、索引 rebuild 策略。
- 顾问、主体、档案、封面模板等内容业务的数据模型。

## 9. Key Performance Strategies

### 9.1 已经在代码中体现的策略

- 页面 lazy load：`src/App.tsx`
- guarded invoke + timeout fallback：`src/bridge/ipcRenderer.ts`
- stale-while-revalidate：多页面用 `hasLoadedSnapshotRef`、`requestId`、`silent reload`
- runtime 统一事件流：减少多通道重复监听
- session artifact 拆分：防止单一 store 文件过大
- knowledge 目录分页：防止知识页首屏一次拉全量
- timeline worker / cache：波形、胶片条、gif 帧不全压在主线程
- tool result budget：减少上下文膨胀

### 9.2 当前最应该继续坚持的性能约束

- 任何页面切换都必须先 render shell，再做 host hydrate。
- 页面级首屏 payload 只拿 summary，不拿全量正文/全量历史/全量资产。
- Host command 默认优先 async；CPU/IO 重操作走后台任务，不放同步 page-entry path。
- 锁只保护内存，不保护磁盘和目录扫描。
- 请求必须有 request token；旧结果不能覆盖新状态。

### 9.3 接下来最值得优先优化的点

- `src/pages/Settings.tsx` 继续拆面板级加载，避免巨页集中观测成本。
- `src/pages/Manuscripts.tsx` 继续把视频/写作/文件管理做更强隔离，减少一个文件承载过多职责。
- `src-tauri/src/main.rs` 继续瘦身，把 assembly 以外逻辑再下沉。
- 对 `Team`、`RedClaw`、`Knowledge` 这类多事件页统一补更显式的 request/version token 规范。

## 10. Recommended Architectural Direction

### 10.1 推荐保留的主路线

- 产品表面继续走“多工作台”而不是“所有能力塞进一个 Chat 页”。
- AI 编排继续走“typed runtime + tool registry + skills + MCP”，而不是 prompt 里硬编码路由。
- 视频继续走“vendored timeline + 自研桥接 + Remotion 导出”。
- 自动化继续走 host-side scheduler，而不是 renderer timer。
- 知识继续走“catalog summary + index status + detail lazy fetch”的混合路线。

### 10.2 不推荐的路线

- 不推荐重新引入大量裸 `invoke()` 和散落 channel 字符串。
- 不推荐用 message keyword heuristic 代替 typed `contextType` / `runtimeMode`。
- 不推荐为每个业务域再拆新顶层 AI tool。
- 不推荐把大型视频/知识/诊断 payload 直接塞入页面首屏。

## 11. Reading Order For New Maintainers

1. `README.md`
2. `docs/architecture/system-overview.md`
3. 本文
4. `src/App.tsx`
5. `src/bridge/ipcRenderer.ts`
6. `src/pages/Manuscripts.tsx`、`src/pages/Knowledge.tsx`、`src/pages/RedClaw.tsx`、`src/pages/Settings.tsx`
7. `src-tauri/src/main.rs`
8. `src-tauri/src/commands/README.md`
9. `src-tauri/src/runtime/README.md`
10. `src-tauri/src/tools/README.md`
11. `src-tauri/src/skills/README.md`
12. `src-tauri/src/knowledge_index/README.md`

## 12. Verification Basis

本文基于以下真实代码与文档路径整理：

- `src/App.tsx`
- `src/bridge/ipcRenderer.ts`
- `src/pages/*.tsx`
- `src/components/manuscripts/*`
- `src/features/video-editor/*`
- `src-tauri/src/main.rs`
- `src-tauri/src/commands/*`
- `src-tauri/src/runtime/*`
- `src-tauri/src/tools/*`
- `src-tauri/src/skills/*`
- `src-tauri/src/mcp/*`
- `src-tauri/src/knowledge_index/*`
- `docs/ipc-inventory.md`
- `docs/architecture/system-overview.md`
- `docs/ai-runtime-maintenance-overview.md`
