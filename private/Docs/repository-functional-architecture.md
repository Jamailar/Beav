---
doc_type: architecture
status: current
last_updated: 2026-04-29
scope: repository
---

# RedConvert 仓库级功能架构拆解

## 1. 文档目标与范围

本文覆盖当前仓库里真实存在、且仍在主链路上起作用的功能模块，目标是回答五件事：

1. 这个仓库到底由哪些产品面组成
2. 每个产品面内部有哪些功能模块，以及分别落在哪些代码目录
3. 模块之间的数据流、调用流和持久化边界是什么
4. 哪些地方必须依赖成熟库，哪些地方应该继续自研
5. 当前架构下最优的演进方向和性能策略是什么

不覆盖内容：

- `archive/desktop-electron/` 的旧 Electron 实现，只作为历史归档
- `desktop/dist/`、`desktop/src-tauri/target/`、`desktop/release/`、`desktop/src-tauri/gen/` 等构建产物
- 仓库外的闭源服务实现细节

---

## 2. 仓库总图

| 产品面 | 目录 | 角色 | 用户价值 | 主技术栈 | 当前结论 |
| --- | --- | --- | --- | --- | --- |
| 桌面端主产品 | `desktop/` | 主工作台 | 采集后的内容沉淀、AI 创作、稿件、媒体、封面、自动化 | React + Tauri + Rust + Remotion | 绝对主系统 |
| 浏览器采集插件 | `Plugin/` | 外部入口 | 把网页、小红书、YouTube、图片、选中文字送入桌面端 | Chrome Extension MV3 | 采集入口 |
| 官网/下载站 | `RedBoxweb/` | 分发与品牌 | 落地页、下载页、Release 镜像入口 | Next.js 16 | 对外分发面 |
| 混合发布脚本 | `private/scripts/hybrid-release/` | 交付链路 | 本地 macOS 构建、远程 Windows 构建、上传 Release | Bash + `gh` + SSH | 发布基础设施 |
| 根目录元数据 | `/README.md`、`/package.json` | 仓库门面 | 对外说明、版本日志、Node 约束 | Markdown + Node metadata | 说明与约束 |

推荐理解顺序：

1. 先把 `Plugin/` 视为“采集入口”
2. 把 `desktop/` 视为“内容生产与自动化内核”
3. 把 `RedBoxweb/` 视为“下载分发门面”
4. 把 `private/scripts/hybrid-release/` 视为“交付流水线”

---

## 3. 仓库级核心链路

### 3.1 内容采集链路

1. 用户在浏览器内触发 `Plugin/` side panel、页面按钮或右键菜单。
2. `Plugin/src/background.js` 负责识别页面类型、拼装采集 payload，并写入桌面端本地 HTTP 接口。
3. 桌面端宿主接收后进入知识库 / 媒体库写入链路。
4. `desktop/src-tauri/src/persistence/` 与 `desktop/src-tauri/src/knowledge_index/` 负责落盘、索引、重建、监听。
5. `desktop/src/pages/Knowledge.tsx`、`Wander.tsx`、`ManuscriptEditorHost.tsx`、`RedClaw.tsx` 消费这些内容做二次创作。

浏览器 AI 控制链路与采集链路并行，不替代结构化采集：

1. 桌面端启动时自动注册内置 `RedBox Browser Control` MCP server，stdio command 指向 RedBox App 自身的 `--redbox-browser-control-mcp` 模式。
2. 内置 MCP 通过本机 JSON-RPC socket 调用 `Plugin/native-host/host.mjs`；`Plugin/mcp-server.mjs` / `Plugin/.mcp.json` 仅作为开发态或外部 MCP 客户端入口。
3. native host 经 Chrome native messaging 转发到扩展 background。
4. `Plugin/src/browserControlBackground.js` 负责 tab/session、DOM snapshot、selector 操作、截图、CDP、页面资产读取等通用浏览器能力。
5. `Plugin/src/browserControlContent.js` 仅在 AI 调用浏览器工具时动态注入；现有 `Plugin/src/pageObserver.js` 和 `Plugin/src/xhsBridge.js` 继续承担结构化采集。

### 3.2 AI 创作链路

1. 用户在桌面端的 `Chat`、`Team`、`Wander`、`RedClaw`、`Manuscripts` 触发 AI 行为。
2. renderer 统一通过 `window.ipcRenderer` 调用宿主。
3. `desktop/src-tauri/src/commands/*` 把请求路由到 runtime、skills、tools、mcp、scheduler、persistence。
4. `desktop/src-tauri/src/runtime/*`、`agent/*`、`subagents/*` 负责 session / task / route / checkpoint / tool execution。
5. `desktop/src-tauri/src/events/` 发出统一 `runtime:event`，前端 `desktop/src/runtime/runtimeEventStream.ts` 分发到对应页面。

### 3.3 稿件到媒体链路

1. 知识、灵感、主体和历史样本进入 `Manuscripts`。
2. 稿件工作台可生成图文包、Remotion 场景、视频片段、字幕与导出任务。
3. 相关媒体文件同步进入 `MediaLibrary`，封面进入 `CoverStudio`，主题和模板进入 `redbox-market` 包体系。
4. 导出后的成品再进入下载、发布、归档或后续自动化流程。

### 3.4 发布分发链路

1. `desktop/` 生成安装包。
2. `private/scripts/hybrid-release/` 在本地/远端构建发布资产。
3. `RedBoxweb/app/lib/release-sync.ts` 同步最新版本资产，把安装包镜像到 OSS，并写 `latest.json` manifest。
4. `RedBoxweb/app/download/page.tsx` 和 `RedBoxweb/app/api/updates/*` 读取 manifest，向用户和客户端展示可下载资产。

---

## 4. 桌面端主产品架构

`desktop/` 是这个仓库的核心。它不是单一聊天客户端，而是一个把知识、AI、稿件、媒体和自动化打通的本地创作工作台。

### 4.1 桌面端分层

| 层 | 主要路径 | 职责 | 必须用现成库 | 必须自研 |
| --- | --- | --- | --- | --- |
| App Shell | `desktop/src/App.tsx`、`desktop/src/components/Layout.tsx` | 导航、懒加载、工作空间切换、全局弹窗、首次引导 | React、Suspense、Lucide | 视图状态、跨页 pending message、启动迁移 |
| Renderer Pages | `desktop/src/pages/*`、`desktop/src/components/*`、`desktop/src/features/*` | 用户可见功能面 | React、Radix、CodeMirror、Zustand | 页面编排、工作台交互、业务状态机 |
| Bridge | `desktop/src/bridge/ipcRenderer.ts` | 统一 IPC facade、fallback、normalize、兼容桥 | Tauri API | 类型化桥接、超时策略、兼容层 |
| Host Commands | `desktop/src-tauri/src/commands/*` | 接收前端请求并路由业务域 | Tauri v2 | 命令域拆分、最小 payload、异步化 |
| Runtime | `desktop/src-tauri/src/runtime/*`、`agent/*`、`subagents/*` | AI 会话、任务、工具、子代理、恢复 | OpenAI-compatible transport、serde | runtime 模式、route、checkpoint、resume |
| Persistence | `desktop/src-tauri/src/persistence/*`、`workspace_loaders.rs` | 本地状态、workspace hydrate、主快照瘦身 | 文件系统、serde_json | 工作区 schema、hydrate 策略、状态迁移 |
| Index / Scheduler | `knowledge_index/*`、`scheduler/*` | 知识索引、监听、重建、定时任务派生 | 文件监听、时间计算 | 目录 schema、后台 job 状态模型 |
| AI Assets | `prompts/`、`skills/`、`builtin-skills/`、`redbox-market/` | 角色、技能、模板、官方包 | Markdown、YAML、JSON | 资产协议、权限、运行时绑定 |

### 4.2 桌面端主要功能面

当前 `desktop/src/App.tsx` 实际懒加载的页面有 13 个主视图，另有 3 个补充页面：

| 视图 | 文件 | 功能定位 | 主要宿主域 |
| --- | --- | --- | --- |
| Chat | `desktop/src/pages/Chat.tsx` | 通用 AI 对话与工具执行 | `chat`、`runtime` |
| Team | `desktop/src/pages/Team.tsx` | 多成员协作总入口 | `advisor_ops`、`chatrooms` |
| Skills | `desktop/src/pages/Skills.tsx` | 技能浏览、管理、启停 | `skills_ai`、`skills/*` |
| Knowledge | `desktop/src/pages/Knowledge.tsx` | 知识库、文档源、YouTube、索引状态 | `library`、`knowledge_index` |
| Settings | `desktop/src/pages/Settings.tsx` | AI、MCP、守护进程、诊断、后台任务 | `system`、`mcp_tools`、`assistant_daemon`、`runtime` |
| Manuscript Editor | `desktop/src/components/manuscripts/ManuscriptEditorHost.tsx` | 稿件编辑、图文包、视频稿、导出 | `manuscripts`、`generation`、`media` |
| Archives | `desktop/src/pages/Archives.tsx` | 创作档案与样本库 | `archives` 相关 channel |
| Wander | `desktop/src/pages/Wander.tsx` | 随机素材联想与选题发散 | `chat_sessions_wander`、`runtime` |
| RedClaw | `desktop/src/pages/RedClaw.tsx` | 自动化创作、长周期任务、运行台 | `redclaw`、`redclaw_runtime`、`scheduler` |
| MediaLibrary | `desktop/src/pages/MediaLibrary.tsx` | AI 图片 / 视频素材总库 | `generation`、`library`、`media` |
| CoverStudio | `desktop/src/pages/CoverStudio.tsx` | 封面模板、封面资产、封面生成 | `cover:*`、`generation` |
| Subjects | `desktop/src/pages/Subjects.tsx` | 人物 / 商品 / 场景等主体资产 | `subjects` |
| Workboard | `desktop/src/pages/Workboard.tsx` | 工作项看板与执行状态 | `redclawRunner`、`work` |
| Advisors | `desktop/src/pages/Advisors.tsx` | Team 子面板，顾问资料管理 | `advisor_ops` |
| CreativeChat | `desktop/src/pages/CreativeChat.tsx` | Team 子面板，多人群聊房间 | `chatrooms`、`advisors` |
| ImageGen | `desktop/src/pages/ImageGen.tsx` | 独立生图页，现更多被媒体库吸收 | `image-gen`、`media` |

---

## 5. 桌面端功能模块细拆

### 5.1 App Shell 与工作空间模块

**实现位置**

- Renderer: `desktop/src/App.tsx`、`desktop/src/components/Layout.tsx`
- Bridge: `desktop/src/bridge/ipcRenderer.ts`
- Host: `desktop/src-tauri/src/commands/spaces.rs`、`workspace_data.rs`
- Persistence: `desktop/src-tauri/src/persistence/mod.rs`

**功能职责**

- 页面懒加载与顶层导航
- 当前 space 切换、创建、重命名
- 首次引导、启动迁移、全局对话框
- 跨页待发送消息和待打开稿件
- 版本信息与升级提示

**关键实现**

- `App.tsx` 维护 `currentView`、`pendingChatMessage`、`pendingRedClawMessage`
- `Layout.tsx` 负责读取 space 列表、切换当前 workspace、显示版本和升级入口
- 页面采用 `React.lazy` + `Suspense` 延迟加载

**库与自研**

- 必须用库：React、Suspense、Lucide
- 自研核心：视图生命周期、space 模型、跨页消息投递、迁移弹窗与启动逻辑

**性能重点**

- 页面先挂壳，再加载数据
- space 切换不得阻塞整个壳层
- 保持 stale-while-revalidate，不能因刷新清空现有页面

### 5.2 IPC Bridge 与事件总线模块

**实现位置**

- Renderer: `desktop/src/bridge/ipcRenderer.ts`
- Renderer runtime: `desktop/src/runtime/runtimeEventStream.ts`
- Host emit: `desktop/src-tauri/src/events/*`

**功能职责**

- 将前端宿主访问集中收敛到 `window.ipcRenderer`
- 对旧 channel 和新 command 做兼容映射
- 对 `runtime:event`、`chat:*`、`creative-chat:*` 做统一事件消费
- 为页面提供超时、fallback、normalize

**关键实现**

- typed facade 对 `spaces`、`subjects`、`mcp`、`assistantDaemon`、`knowledge`、`chat` 等域进行封装
- listener 的注册和反注册统一维护，避免页面泄漏
- runtime 事件按 `sessionId`、`taskId`、`runtimeId` 做隔离分发

**库与自研**

- 必须用库：`@tauri-apps/api`
- 自研核心：兼容层、fallback shape、事件协议、页面隔离策略

**推荐结论**

- 最优方案是继续保持“桥接层集中 + 页面 typed facade”，不要退回裸 `invoke()`
- 不推荐全量自动 codegen IPC client，因为当前仓库仍处在迁移与兼容并存阶段

### 5.3 AI Runtime 与会话任务模块

**实现位置**

- Runtime: `desktop/src-tauri/src/runtime/*`
- Agent: `desktop/src-tauri/src/agent/*`
- Subagents: `desktop/src-tauri/src/subagents/*`
- Commands: `runtime.rs`、`runtime_query.rs`、`runtime_routing.rs`、`runtime_orchestration.rs`、`runtime_session.rs`、`runtime_tasks.rs`

**功能职责**

- 把聊天、RedClaw、Wander、后台任务统一抽象成 session / task / route / checkpoint
- 处理模型调用、工具调用、任务恢复、断点续跑、子代理聚合
- 将“用户请求”转换为“结构化 runtime route”

**关键实现**

- `config_runtime.rs`：运行模式和模型配置解析
- `task_runtime.rs`：任务创建、状态变更、trace、checkpoint、resume graph
- `interactive_loop.rs`：交互式 tool round 管理
- `agent/engine.rs`：不同场景的 turn 构建与 agent 执行封装
- `subagents/spawner.rs`、`aggregation.rs`：并行子代理与结果聚合

**库与自研**

- 必须用库：OpenAI-compatible transport、serde
- 自研核心：runtime 模式、tool budget、checkpoint persistence、child task lineage、resume 机制

**推荐结论**

- 最优方案是继续坚持 typed route / typed metadata
- 不推荐靠 prompt 中关键词硬判断页面意图，这会直接破坏 runtime 可恢复性和后续自动化稳定性

### 5.4 Skills / Tools / MCP 模块

**实现位置**

- Skills: `desktop/src-tauri/src/skills/*`
- Tools: `desktop/src-tauri/src/tools/*`
- MCP: `desktop/src-tauri/src/mcp/*`
- Commands: `skills_ai.rs`、`mcp_tools.rs`
- Assets: `desktop/prompts/`、`desktop/skills/`、`desktop/builtin-skills/`

**功能职责**

- 装载技能、监听技能变更、控制技能权限
- 为不同 runtime mode 提供 tool pack 和 schema
- 发现本地 MCP 配置，管理会话与调用
- 为不同 Agent 角色提供 prompt、模板、能力包

**关键实现**

- `skills/loader.rs` 负责发现和解析技能
- `skills/permissions.rs` 用运行模式约束技能边界
- `tools/registry.rs`、`packs.rs`、`guards.rs` 管理 canonical tools 和 action 协议
- `mcp/transport.rs` 与 `mcp/session.rs` 管理 stdio / 本地配置发现 / probe / call

**库与自研**

- 必须用库：MCP 协议生态、JSON schema、文件监听
- 自研核心：tool pack、guard、compat alias、skill activation scope、prompt 资产组织

**当前最佳实践**

- 顶层工具继续收敛到少数 canonical tool，不再无上限膨胀
- 能用 `action + payload` 表达的能力，不再拆新顶层工具

### 5.5 知识库与索引模块

**实现位置**

- Page: `desktop/src/pages/Knowledge.tsx`
- Commands: `desktop/src-tauri/src/commands/library.rs`
- Index: `desktop/src-tauri/src/knowledge_index/*`
- Persistence: `desktop/src-tauri/src/persistence/mod.rs`

**功能职责**

- 展示采集笔记、YouTube 内容、文档源、索引状态
- 支持导入文档、导入文件夹、导入 Obsidian vault
- 支持转写、摘要重试、删除、目录重建、索引根目录打开
- 作为 Wander、Manuscripts、RedClaw 的上游素材池

**关键实现**

- `knowledge_index/schema.rs` 定义索引结构
- `catalog.rs` 提供目录查询
- `indexer.rs` 与 `jobs.rs` 负责重建和后台任务
- `watcher.rs` 监听内容变更
- 前端通过 `knowledge:*` 以及 `library.rs` 的 page/detail/status API 读取最小摘要

**库与自研**

- 必须用库：文件监听、向量模型 API、YouTube/文档解析相关依赖
- 自研核心：catalog schema、workspace-first ingest contract、索引状态摘要

**性能重点**

- 索引重建不能阻塞页面打开
- 页面首屏只取 catalog 和 status 摘要，不取全量大对象
- watch/rebuild 必须走后台任务，不要占用 UI 关键路径

### 5.6 Wander 选题模块

**实现位置**

- Page: `desktop/src/pages/Wander.tsx`
- Page private: `desktop/src/components/wander/*`
- Host: `desktop/src-tauri/src/commands/chat_sessions_wander.rs`
- Runtime: `runtime/*`、`agent/wander.rs`

**功能职责**

- 从知识库里抽样内容并生成联想式选题
- 将灵感继续投喂到 Chat、Manuscripts、RedClaw
- 管理 Wander session 的进度、结果和后续创作动作

**关键实现**

- Wander 不是孤立 prompt，而是一个绑定 session 的运行模式
- 结果会以结构化上下文回流到其他创作模块
- 页面私有组件极少，说明核心复杂度在 runtime 与 session 组织，而不是 UI 控件数量

**库与自研**

- 必须用库：React UI、LLM transport
- 自研核心：wander session 类型、素材抽样策略、结果回流协议

**推荐结论**

- 最优路径是继续把 Wander 作为 runtime mode，而不是做成单独的一次性 prompt 工具

### 5.7 Chat / Team / Advisors / CreativeChat 模块

**实现位置**

- Pages: `Chat.tsx`、`Team.tsx`、`Advisors.tsx`、`CreativeChat.tsx`
- Commands: `chat.rs`、`chat_state.rs`、`chatrooms.rs`、`advisor_ops.rs`
- Runtime: `agent/chat.rs`、`session_runtime.rs`

**功能职责**

- 单聊对话
- 顾问配置、顾问模板、顾问知识
- 多人群聊房间和多角色发言
- 上下文绑定、附件选取、音频转写、诊断会话

**关键实现**

- `chat_state.rs` 负责 session id、context binding、runtime mode 推断
- `chatrooms.rs` 负责房间列表、消息、清空、取消、更新
- `advisor_ops.rs` 负责顾问资料 CRUD 与模板
- `CreativeChat.tsx` 组合房间、成员、消息和附件链路

**库与自研**

- 必须用库：React、流式事件、音频处理相关库
- 自研核心：room/session 绑定、multi-advisor 协作协议、上下文绑定元数据

**性能重点**

- 消息列表必须按增量事件更新，不能每次全量重算
- 多 session 下事件必须严格隔离，防止串页

### 5.8 Manuscripts 稿件工作台模块

**实现位置**

- Editor host: `desktop/src/components/manuscripts/ManuscriptEditorHost.tsx`
- Components: `desktop/src/components/manuscripts/*`
- Feature store: `desktop/src/features/video-editor/store/useVideoEditorStore.ts`
- Host: `desktop/src-tauri/src/commands/manuscripts.rs`
- Shared rendering: `desktop/src/remotion/*`、`desktop/remotion/render.mjs`

**功能职责**

- 稿件树、文件夹、稿件 CRUD
- 图文稿编辑、主题切换
- 视频稿与音频稿编辑
- 包状态、外部素材绑定、AI 写作 proposal、导出与预览
- Remotion 场景生成与视频渲染

**关键实现**

- `manuscripts.rs` 是宿主里最重的业务域之一，负责从文件树到包状态再到渲染入口
- `components/manuscripts/VideoDraftWorkbench.tsx` 承担轨道、片段、字幕、文本块、状态同步
- `editorProject.ts`、`freecutTimelineBridge.ts` 负责编辑器协议与 vendored timeline 适配
- `WritingDraftWorkbench.tsx` 负责图文主题、预览卡片、富文包导出
- Remotion 预览与 CLI 导出分离，UI 预览走 `components/manuscripts/remotion/*`，实际渲染走 `src/remotion/` + `remotion/render.mjs`

**库与自研**

- 必须用库：Remotion、CodeMirror、Wavesurfer、mediabunny、Zustand、vendored FreeCut timeline
- 自研核心：稿件包协议、轨道/片段模型、主题与长文 layout 资产、写作 proposal 流程

**最佳架构选择**

- 当前最优方案是“React 编辑器 + Zustand store + Remotion 导出 + vendored timeline 桥接”
- 不推荐把视频编辑重写到 Rust host；那会显著增加状态同步成本并拖慢前端迭代

**性能重点**

- 时间线与预览状态必须统一来源，避免 timeline / scene / preview 漂移
- 大量 clip 更新必须走局部 state patch，不可每次全量重建整个 project
- 导出与转录必须异步化，并通过事件回传进度

### 5.9 Media Library / ImageGen / VideoGen 模块

**实现位置**

- Pages: `MediaLibrary.tsx`、`ImageGen.tsx`
- Commands: `generation.rs`、部分 `library.rs` / `manuscripts.rs`
- Persistence: workspace 媒体存储与绑定记录

**功能职责**

- 统一展示 AI 图、导入图、项目图、稿件关联图
- 直接发起生图与视频生成
- 打开素材根目录、素材详情、素材绑定和删除

**关键实现**

- `generation.rs` 是图片/视频生成任务的宿主入口
- `ManuscriptEditorHost.tsx` 也会直接消费 `image-gen:generate`、`video-gen:generate`，说明媒体生成已深度嵌入稿件链路
- 媒体库是共享资源池，而不是孤立页面

**库与自研**

- 必须用库：模型供应商 API、文件系统、预览/缩略图基础库
- 自研核心：媒体元数据模型、稿件绑定关系、生成结果回流

### 5.10 Cover Studio 模块

**实现位置**

- Page: `desktop/src/pages/CoverStudio.tsx`
- Host channels: `cover:list`、`cover:generate`、`cover:open-root`、`cover.templates.*`
- Assets: `desktop/redbox-market/packages/official/cover-template-pack`

**功能职责**

- 管理封面模板
- 导入历史模板
- 使用标题组、底图、素材生成封面
- 将封面资产保存回封面库

**关键实现**

- 模板 CRUD 与资产生成分离
- Knowledge 页面也能调用 `cover.templates.save`，说明封面模板不是封面页私有资产，而是跨页面复用资产

**库与自研**

- 必须用库：图像合成相关依赖、文件系统
- 自研核心：封面模板协议、标题组参数、跨模块模板复用

### 5.11 Subjects 主体资产模块

**实现位置**

- Page: `desktop/src/pages/Subjects.tsx`
- Commands: `desktop/src-tauri/src/commands/subjects.rs`
- Persistence: `ensure_store_hydrated_for_subjects`

**功能职责**

- 管理人物、商品、场景等主体
- 分类、创建、编辑、删除
- 为写稿、生图、封面、角色配置提供结构化参考资产

**关键实现**

- `subjects.categories.*` 与 `subjects.*` 为两层模型：分类层和主体层
- 页面一次拉取分类和主体，说明该域当前更偏“资产面板”而非流式工作流

**库与自研**

- 必须用库：React、表单基础库
- 自研核心：主体 schema、引用关系、图片/属性/声音等多模态字段组织

### 5.12 Archives 创作档案模块

**实现位置**

- Page: `desktop/src/pages/Archives.tsx`
- Host channels: `archives:list`、`archives:create`、`archives:update`、`archives:samples:*`

**功能职责**

- 维护创作档案 profile
- 维护 profile 下的样本库
- 作为风格、样例、历史表达的沉淀区域

**关键实现**

- profile 与 sample 分层
- 页面通过事件 `archives:sample-created` 做增量刷新

**库与自研**

- 必须用库：React
- 自研核心：profile/sample 模型和与其他创作域的引用关系

### 5.13 RedClaw / Workboard / Scheduler / Daemon 模块

**实现位置**

- Pages: `RedClaw.tsx`、`Workboard.tsx`
- Page private: `desktop/src/pages/redclaw/*`
- Commands: `redclaw.rs`、`redclaw_runtime.rs`、`assistant_daemon.rs`
- Scheduler: `desktop/src-tauri/src/scheduler/*`

**功能职责**

- 单轮任务、定时任务、长周期任务
- 背景 job 派生、重试、死信、心跳、手动触发
- 执行历史、工作项列表、队列状态
- 守护进程状态、微信登录、机器人联动

**关键实现**

- `scheduler/mod.rs` 负责 job definition 同步和后台任务派生
- `job_runtime.rs` 负责排队、重试、归档、运行一次队列
- `heartbeat.rs` 负责执行过程 heartbeat
- `Workboard.tsx` 通过 `work.list` 和 `redclawRunner.run*Now` 暴露操作面
- `Settings.tsx` 同时承担 scheduler/daemon 诊断入口

**库与自研**

- 必须用库：时间计算、线程/异步任务、消息事件
- 自研核心：任务 DSL、后台状态机、重试/死信策略、运行时与工作项映射

**最佳架构选择**

- 当前最优方案是“调度计算在 scheduler，模型执行留在 runtime/commands”
- 不推荐把 schedule 逻辑硬塞回页面，也不推荐让 scheduler 直接掌管模型执行细节

### 5.14 Settings / Official / Diagnostics 模块

**实现位置**

- Page: `desktop/src/pages/Settings.tsx`
- Page private: `desktop/src/pages/settings/*`
- Feature: `desktop/src/features/official/*`
- Commands: `system.rs`、`mcp_tools.rs`、`official.rs`、`plugin.rs`、`assistant_daemon.rs`

**功能职责**

- AI endpoint / model 配置
- MCP 服务器发现、导入、本地配置、OAuth 状态、连接测试
- 插件准备、插件目录打开、知识库 API 指南
- YouTube/yt-dlp 内置下载服务移除，不再安装、更新或探测第三方二进制
- runtime 诊断、工具诊断、会话和任务追踪
- 官方账号登录、模型列表、积分 / 面板数据
- 守护进程配置与控制

**关键实现**

- `Settings.tsx` 是系统控制台，包含大量宿主域的只读和可写入口
- `generatedOfficialAiPanel.tsx` 是前端中高度绑定宿主状态的官方能力面板
- `assistant_daemon` 通过事件流回传 daemon 状态和日志

**库与自研**

- 必须用库：React、表单与状态工具、宿主 API
- 自研核心：诊断模型、配置持久化、官方能力与宿主状态桥接

**性能重点**

- 设置页必须分区独立刷新，单区失败不允许拖垮全页
- 诊断数据和 runtime trace 只能按需拉取，不能在页面进入时全量预热

---

## 6. 插件架构

### 6.1 模块拆解

| 模块 | 文件 | 职责 | 关键实现 |
| --- | --- | --- | --- |
| MV3 清单 | `Plugin/src/manifest.json` | 声明权限、service worker、content script、popup | 允许本地 HTTP、上下文菜单、更新检查 |
| 后台服务 | `Plugin/src/background.js` | 页面识别、保存动作、更新检查、右键菜单、本地服务健康检查 | 统一消息分发与采集执行 |
| 浏览器控制后台 | `Plugin/src/browserControlBackground.js` | MCP/native host 命令路由、tab/session、DOM、截图、CDP、下载状态 | 叠加到 background，消息类型加前缀，避免抢答既有采集消息 |
| 浏览器控制内容脚本 | `Plugin/src/browserControlContent.js` | AI 控制时的 DOM snapshot、selector 查询、点击、输入、资产读取 | 通过 `chrome.scripting.executeScript` 动态注入 |
| MCP 入口 | `desktop/src-tauri/src/browser_control_mcp.rs`、`Plugin/mcp-server.mjs`、`Plugin/.mcp.json` | 向桌面端 AI 暴露 browser-control stdio MCP server | App 内置 Rust MCP 入口自动注册；JS MCP 入口用于开发调试和外部客户端 |
| Native host | `Plugin/native-host/host.mjs` | Chrome native messaging 与本机 JSON-RPC socket 桥接 | host 方法本地处理，浏览器方法转发给扩展 |
| 内容脚本 | `Plugin/src/pageObserver.js` | 对小红书、YouTube、公众号、抖音等页面做 DOM / 路由观察 | 抽取页面元信息和拖拽图片 payload |
| 路由桥 | `Plugin/src/pageRouteBridge.js` | 监听 SPA 路由变化 | patch `pushState` / `replaceState` 并发事件 |
| 弹窗 UI | `Plugin/src/popup.html`、`Plugin/src/popup.js`、`Plugin/src/popup.css` | 当前页状态展示、主保存按钮、更新提示 | 持续轮询当前页信息和桌面端健康状态 |

### 6.2 功能模块

**内容识别模块**

- 识别小红书笔记、YouTube 视频、公众号文章、抖音视频、普通网页
- `pageObserver.js` 同时用 DOM 和页面内初始状态对象做兜底识别
- 对 SPA 页面通过 `pageRouteBridge.js` 侦测路由变更，避免只在首次加载识别

**保存动作模块**

- 保存当前页内容
- 保存当前链接
- 保存选中文字
- 保存图片到素材库
- 保存视频到知识库
- popup 与右键菜单共用后台动作

**桌面端接入模块**

- `background.js` 维护多个本地 API 候选地址：
  - `http://127.0.0.1:31937/api/knowledge`
  - `http://localhost:31937/api/knowledge`
  - `http://127.0.0.1:23456/api/knowledge`
  - `http://localhost:23456/api/knowledge`
- 这说明插件被设计成“弱依赖宿主实现细节，强依赖本地 HTTP contract”

**自动更新模块**

- 每 360 分钟通过 `alarms` 检查一次更新
- 更新源固定为 `https://redbox.ziz.hk/api/updates/plugin`
- 更新策略是提示用户重新加载插件，不是自动热更新

### 6.3 插件为什么这样实现

**当前最优方案：本地 HTTP + MV3 service worker**

优点：

- 不需要浏览器 Native Messaging
- 宿主端升级对插件的耦合更低
- popup、右键菜单、content script 都能共用一个保存接口

替代方案：

- Native Messaging：更深度，但安装与权限成本高
- WebSocket 常驻连接：实时性更强，但 MV3 service worker 生命周期更复杂

推荐结论：

- 当前仓库最优解仍是本地 HTTP 接口
- 如果后续要扩到批量高吞吐采集，再考虑引入 WebSocket 作为增量通道，而不是替换掉 HTTP 主链路

---

## 7. 官网与下载站架构

### 7.1 模块拆解

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 官网首页 | `RedBoxweb/app/page.tsx` | 品牌表达、核心价值陈述、能力展示 |
| 下载页 | `RedBoxweb/app/download/page.tsx` | 展示 macOS / Windows 安装包下载入口 |
| 公共组件 | `RedBoxweb/app/components/*` | Header、视觉区块 |
| 更新源读取 | `RedBoxweb/app/lib/downloads.ts`、`manifest.ts`、`updates.ts` | 读取 latest manifest，选出主下载资产并构造更新响应 |
| 版本同步 | `RedBoxweb/app/lib/release-sync.ts` | 从源仓库版本资产拉取安装包并镜像到 OSS |
| 测试 | `RedBoxweb/tests/release-sync.test.ts` | 验证 release asset 解析与同步流程 |

### 7.2 功能模块

**品牌官网模块**

- 首页主要承担定位表达，不承担复杂后台系统
- 目前是轻内容站，不是完整 CMS

**下载分发模块**

- 不是直接读取 GitHub 页面 HTML，而是读取结构化 manifest
- `downloads.ts` 会根据平台和架构挑主安装包：
  - macOS arm64
  - macOS x64
  - Windows x64

**Release 镜像模块**

- `release-sync.ts` 只镜像 `.dmg`、`.zip`、`.exe`
- 会忽略 `latest.yml`、`.blockmap`
- 当 manifest tag 未变化时跳过同步
- 所有资产上传成功后才写 `latest.json`

### 7.3 架构选择与推荐

**当前最优方案：源仓库版本资产作为输入，OSS manifest 作为分发面**

优点：

- 源仓库继续保存版本资产和更新日志
- 官网下载和客户端更新不直接依赖源仓库 API 配额和实时性
- 可以沉淀自己的公开下载域名与缓存策略

替代方案：

- 官网直接调源仓库 API：实现更简单，但稳定性和带宽控制较差
- 官网自建发布后台：过重，不符合当前仓库规模

推荐结论：

- 继续保持 “版本资产 -> OSS mirror -> latest manifest -> 下载页 / 更新 API” 是最优解

---

## 8. 发布与交付链路

### 8.1 发布脚本模块

| 脚本 | 文件 | 职责 |
| --- | --- | --- |
| 本地 mac 构建 | `private/scripts/hybrid-release/build-mac-local.sh` | 本地打包 macOS 产物 |
| 远端 win 构建 | `private/scripts/hybrid-release/build-win-on-remote.sh` | SSH 到远端 Linux 构建 Windows 包 |
| notarize | `private/scripts/hybrid-release/notarize-mac-artifacts.sh` | macOS 公证 |
| 上传发布资产 | `private/scripts/hybrid-release/upload-release.sh` | 上传构建产物到源仓库版本资产区 |
| 总控入口 | `private/scripts/hybrid-release/publish-hybrid.sh` | 串联 win/mac 构建、上传、tag/push |

### 8.2 发布设计要点

- 不依赖 GitHub Hosted build minutes
- 使用远端 Linux 主机承接 Windows 构建
- 本地 Mac 承接签名和公证
- Release Notes 从根 `README.md` 的 changelog 中提取

### 8.3 推荐结论

对于当前仓库规模，混合发布是合理解：

- 桌面端依赖本地签名环境，完全云端化收益有限
- 远端 Linux 替代本地交叉打包 Windows，能显著降低本机环境复杂度

不推荐：

- 现在就重写成全 GitHub Actions 发布链
- 现在就引入更重的发行管理平台

---

## 9. 哪些必须用成熟库，哪些必须自研

### 9.1 必须用成熟库的部分

| 领域 | 当前库/平台 | 原因 |
| --- | --- | --- |
| 桌面壳层 | Tauri v2 | 跨平台桌面壳、IPC、系统能力接入 |
| 前端框架 | React | 页面编排、复杂交互、生态稳定 |
| 视频渲染 | Remotion | 组合式视频渲染与导出 |
| 富文本/代码编辑 | CodeMirror | 编辑能力成熟 |
| 轨道音频/波形 | Wavesurfer | 音频可视化现成方案 |
| UI 原语 | Radix UI | 对话框、菜单、基础交互组件 |
| 扩展平台 | Chrome MV3 | 浏览器采集的唯一合理宿主 |
| 官网框架 | Next.js | SSR/静态混合与下载站实现成本低 |
| 版本资产源 | 源仓库版本资产 | 版本、附件、发布说明天然契合 |
| MCP 协议生态 | MCP server/client 体系 | 外部工具接入标准化 |

### 9.2 必须自研的部分

| 领域 | 原因 |
| --- | --- |
| workspace / store schema | 这是产品的数据骨架，无法外包给通用库 |
| runtime session / task / route 模型 | 直接决定 AI 自动化能力上限 |
| skill / tool pack / permission 模型 | 是产品能力边界，不是普通插件系统 |
| knowledge catalog 与采集 contract | 与插件、知识、漫步、稿件强绑定 |
| manuscript package 协议 | 涉及图文、视频、模板、导出一体化 |
| RedClaw job / scheduler 状态机 | 是产品自动化中枢 |
| subject / archive / cover template 资产模型 | 是内容工作台的独特资产层 |

---

## 10. 仓库级性能优化策略

### 10.1 已经体现出来的正确策略

- 页面懒加载：`desktop/src/App.tsx`
- Bridge fallback：宿主不稳定时页面不直接炸
- Persistence 锁与 I/O 分离：`with_store` / `with_store_mut` + hydrate
- runtime 统一事件流：避免页面自己乱做长轮询
- Knowledge index 单独模块化：重建与监听不塞进页面命令
- Release manifest 化：下载页不直接做重网络依赖

### 10.2 必须继续坚持的策略

**页面层**

- 页面进入只拉摘要，详情按需加载
- 保留旧数据并后台刷新，不做全页 loading 覆盖
- 长列表、轨道、日志、trace 必须持续控制首屏载荷

**宿主层**

- page-facing command 默认 async
- CPU 重任务放后台或分离进程
- 大对象不直接塞 IPC，先返回 id / path / summary

**AI runtime 层**

- tool result 做 budget 截断
- session artifact 继续拆文件，主 store 保持瘦身
- 子代理结果聚合只回传摘要和关键产物

**视频链路**

- timeline 更新做局部 patch
- Remotion 预览与最终导出分离
- 缩略图、转录、渲染进度全部异步事件化

**插件链路**

- 继续缓存 page state 与 API 探测结果
- SPA 站点识别保持 debounce + route bridge，不做高频全量扫描

### 10.3 当前高风险热点

- `desktop/src/components/manuscripts/ManuscriptEditorHost.tsx`
- `desktop/src/components/manuscripts/VideoDraftWorkbench.tsx`
- `desktop/src/pages/Settings.tsx`
- `desktop/src-tauri/src/commands/manuscripts.rs`
- `desktop/src-tauri/src/main.rs`
- `Plugin/src/pageObserver.js`

这些位置不是不能继续演进，而是每次改动都必须把“首屏、增量更新、事件隔离、异步边界”当成第一优先级。

---

## 11. 最优架构建议

### 11.1 对当前仓库，推荐的总架构形态

最优解不是拆成很多独立仓库，而是继续保持：

1. `desktop/` 作为产品内核
2. `Plugin/` 作为轻量采集入口
3. `RedBoxweb/` 作为对外下载站
4. `private/scripts/hybrid-release/` 作为交付基础设施

原因：

- 这四块共享同一品牌、同一 release 节奏、同一内容工作流
- 真正复杂的域逻辑都在桌面端，拆仓不会减少复杂度，只会增加协作成本
- 插件和下载站都只是主产品的边缘面，不值得独立出更重的工程边界

### 11.2 对桌面端，推荐的长期演进方向

**推荐继续强化的边界**

- page orchestration 留在 `src/pages/*`
- host access 统一走 bridge
- runtime 决策留在 `runtime/*` 与 `agent/*`
- workspace 文件逻辑继续留在 `persistence/*`
- scheduler 继续只管时间和任务派生，不直接吞掉执行逻辑

**不推荐的方向**

- 页面直接调裸 Tauri API
- 把 AI 行为散落到每个页面自己拼 prompt
- 把视频编辑器核心状态拆成多个互不一致的 local state
- 把插件采集逻辑迁回桌面内置浏览器

---

## 12. 建议的阅读入口

- 桌面端系统总览：`desktop/docs/architecture/system-overview.md`
- 桌面端模块细拆：`desktop/docs/architecture/product-module-breakdown.md`
- IPC 清单：`desktop/docs/ipc-inventory.md`
- Runtime 维护视图：`desktop/docs/ai-runtime-maintenance-overview.md`
- 插件入口：`Plugin/README.md`
- 发布链路：`private/scripts/hybrid-release/README.md`

---

## 13. 一句话总结

这个仓库本质上不是“桌面应用 + 几个附属脚本”，而是一个围绕本地化 AI 创作工作台构建的完整内容生产系统：

- `Plugin/` 负责把外部世界采进来
- `desktop/` 负责把素材变成知识、任务、稿件、媒体和自动化执行
- `RedBoxweb/` 负责把最终产物分发出去
- `private/scripts/hybrid-release/` 负责把桌面产品稳定交付到用户手里
