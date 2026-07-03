# `src/bridge/`

本目录是 renderer 到宿主的唯一推荐接入层。

## Entry Point

- [ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/ipcRenderer.ts)

## Module Layout

- [core.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/core.ts): Electron IPC 内核，负责通过 preload `__RED_ELECTRON_IPC__` 调用 channel、监听事件、处理 timeout、normalize 和 fallback。
- [fallbacks.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/fallbacks.ts): 稳定 fallback response registry，优先放官方账号不可用、通知远端不可用和列表空态。
- [types.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/types.ts): bridge core 与 listener/fallback 公共类型，保持和正式版 domain bridge 可复用。
- [domains/accountsBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/accountsBridge.ts): 账号 facade，对齐正式版 `accounts.list/get` 方法名；Electron 开源版当前返回空账号列表或明确 unavailable，不接正式版账号后端。
- [domains/advisorsBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/advisorsBridge.ts): 顾问 / YouTube 顾问 facade，对齐正式版 `advisors` 和旧顶层 YouTube helper 方法名；Electron 版复用现有顾问、知识文件、YouTube 字幕和后台 runner IPC，未迁移的会员技能检查 / 文件夹选择返回明确 fallback。
- [domains/aiConfigBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/aiConfigBridge.ts): AI 配置 facade，对齐正式版角色、协议探测和连接测试方法名，并保留 Electron 设置页已有的 `fetchModels`。
- [domains/analyticsBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/analyticsBridge.ts): 埋点 facade，对齐正式版方法名；Electron 开源版默认禁用并返回 no-op 结果，不新增联网行为。
- [domains/appBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/appBridge.ts): App/system 基础 facade，对齐正式版版本、onboarding、更新检查、打开路径 / 外链、剪贴板和知识库 API 文档入口；Electron 版 onboarding 保留 localStorage，updater 安装保留 unavailable fallback。
- [domains/archivesBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/archivesBridge.ts): 创作档案 facade，对齐正式版 `archives` / `archives.samples` 方法名，复用 Electron 现有档案与样本库 IPC。
- [domains/assistantControlBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/assistantControlBridge.ts): Assistant daemon / 公众号 facade，对齐正式版 `assistantDaemon` 和 `wechatOfficial` 方法名，复用 Electron 现有 daemon、ACP 和公众号草稿 handler。
- [domains/authBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/authBridge.ts): 账号 / LLM readiness facade，对齐正式版 `officialAuth`、`llmReadiness` 和 `auth` 方法名；Electron 开源版继续返回匿名 / 不可用空态，不启用会员、积分、支付或官方登录后端。
- [domains/audioVoiceBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/audioVoiceBridge.ts): 录音 / 音色 facade，对齐正式版 `audio.*` 与 `voice.*` 方法名；Electron 版只接现有录音输入，`voice.*` 返回空态或 unavailable，不启用生音频 / 数字人后端。
- [domains/captureBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/captureBridge.ts): 采集 facade，对齐正式版 `capture.*` 方法名；YouTube 本地保存复用现有 handler，服务端采集继续由 fallback 返回 unavailable / 空列表。
- [domains/chatBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/chatBridge.ts): Chat facade，对齐正式版 `chat` 附件、上下文会话和消息方法，并保留 Electron 版 `chatrooms`；正式版 `sessions/sessionBridge` 仍由独立 `sessionsBridge` 承载，避免覆盖归档版审计兼容面。
- [domains/cliRuntimeBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/cliRuntimeBridge.ts): CLI runtime facade，对齐正式版工具检测、诊断、环境、安装和执行方法名；Electron 版当前主要走稳定 fallback，`diagnose` 保留 renderer 侧 detect/inspect 组合。
- [domains/coverBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/coverBridge.ts): 封面 facade，对齐正式版 `cover` 方法名；Electron 版 `generate` 保留素材 preflight 后再调用现有 cover IPC。
- [domains/filesBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/filesBridge.ts): 文件操作 facade，复用现有 Electron `file:*` handler，支撑预览解析、另存、打包下载和在文件夹中显示。
- [domains/generationBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/generationBridge.ts): 生成任务 facade，对齐正式版 `generation.*` 方法名；图片 / 视频提交保留素材 preflight，音频 / voice / retalk 等未迁移后端继续走明确 fallback。
- [domains/knowledgeBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/knowledgeBridge.ts): 知识库 facade，对齐正式版 `knowledge`、`embedding` 和 `similarity` 方法名，并保留 Electron 版 `memory`、文件索引 scope status 和旧顶层 `readYoutubeSubtitle` 兼容入口。
- [domains/manuscriptsBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/manuscriptsBridge.ts): 稿件 facade，对齐正式版 `manuscripts` 基础方法，并保留 Electron 版已有富文本卡片、包稿、时间线和主题导出扩展方法。
- [domains/mediaBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/mediaBridge.ts): 媒体库 facade，对齐正式版 `media`、`imageGeneration` 和 `videoGeneration` 方法名，复用 Electron 现有媒体库、生图和生视频 IPC。
- [domains/mcpBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/mcpBridge.ts): MCP facade，对齐正式版 `mcp` 方法名，复用 Electron 现有 MCP 配置、测试、导入和 session/tool/resource fallback。
- [domains/notificationsBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/notificationsBridge.ts): 通知 facade，对齐正式版方法名；Electron 开源版当前返回系统通知不可用和远端通知空集合，不接远端通知服务。
- [domains/pluginsBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/pluginsBridge.ts): 插件 facade，对齐正式版 `plugins` 方法名；Electron 版当前列表 / 市场类方法返回空态，安装 / 启停等未迁移能力返回明确 unavailable。
- [domains/redclawBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/redclawBridge.ts): RedClaw facade，对齐正式版 runner、profile、projects 和 orchestration 方法名；Electron 版 runner / profile 复用现有 IPC，未迁移的项目编排、导出和风格定义返回明确 fallback。
- [domains/runtimeBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/runtimeBridge.ts): Runtime / task facade，对齐正式版 `runtime`、`taskPanel`、`backgroundTasks`、`backgroundWorkers`、`tasks` 和 `work` 方法名；Electron 版复用现有任务 IPC，session import/export/events/model config 返回稳定 fallback。
- [domains/settingsBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/settingsBridge.ts): 设置基础 facade，对齐正式版 `getSettings/saveSettings/pickWorkspaceDir` 和 settings/data change 事件。
- [domains/sessionsBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/sessionsBridge.ts): Electron 会话 facade，收敛归档版 `sessions` 审计 API 和正式版已有 `sessionBridge` 外部会话 / 审批调用面。
- [domains/skillsBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/skillsBridge.ts): 技能 facade，对齐正式版 `listSkills` / `skills.*` 方法名，并保留 Electron 现有 `skills.marketSearch`。
- [domains/spacesBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/spacesBridge.ts): 空间切换 facade，接口对齐正式版，Electron 版内部把 `{ name }` 创建 payload 转回旧主进程字符串参数。
- [domains/subjectsBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/subjectsBridge.ts): 资产 / 主体 facade，对齐正式版 `subjects` 和 `brandWorkspace` 方法名；Electron 版 `subjects` 复用现有主体库 IPC，`brandWorkspace` 保持空态 / unavailable。
- [domains/systemBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/systemBridge.ts): Electron 系统 facade，收敛归档版 `debug`、`logs`、`startupMigration`、浏览器插件、富文本主题指南和旧 YouTube 工具入口；不覆盖已拆出的 app / files / settings / notifications / window controls domain。
- [domains/teamRuntimeBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/teamRuntimeBridge.ts): Team runtime facade，对齐正式版 `teamRuntime` / `collab` 方法名，并保留 Electron 版 `runExternalMember` 扩展。
- [domains/toolsBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/toolsBridge.ts): 工具 hooks / diagnostics facade，对齐正式版 `toolHooks` 和 `toolDiagnostics` 方法名，复用 Electron 现有工具诊断 service。
- [domains/topicCenterBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/topicCenterBridge.ts): Topic center 兼容 facade，对齐正式版 `topicCenter` 方法名；Electron 版当前只返回空列表或明确 unavailable，不启用正式版 topic center 后端或 UI 入口。
- [domains/wanderBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/wanderBridge.ts): 漫步 facade，对齐正式版 `wander` 方法名，复用 Electron 现有随机选题、历史、brainstorm 和进度 / 结果事件。
- [domains/videoEditorBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/videoEditorBridge.ts): 视频编辑 facade，对齐正式版 `videoEditorV2` 方法名，复用 Electron 现有 V2 视频编辑项目、字幕、时间线和渲染 IPC。
- [domains/windowControlsBridge.ts](/Users/Jam/LocalDev/GitHub/RedConvert/archive/desktop-electron/src/bridge/domains/windowControlsBridge.ts): 窗口控制 facade，对齐正式版 `windowControls` 方法名；Electron 版支持最小化、最大化切换和关闭，`startDragging` 暂为 no-op。
- `ipcRenderer.ts`: Electron transport、显式 command/channel route、fallback 和 domain 组合入口；业务 facade 应继续放在 `domains/`。

## Responsibilities

- 暴露 `window.ipcRenderer`
- 统一处理 command/channel 路由；正式版 command 名在 Electron 版映射回既有 channel
- 提供 timeout、fallback、normalize
- 维护少量显式 command/channel 映射
- 收敛宿主能力入口，例如 `audio:*` 这类页面级共享能力

## Rules

- 新页面不要直接使用裸 `invoke` 或 `listen`
- 新 host 能力优先在 bridge facade 加 typed wrapper，再由 `ipcRenderer.ts` 暴露
- 新 fallback shape 必须稳定，避免页面自己猜
- 不要在 Electron renderer 侧新增 Tauri API 依赖；正式版 UI 需要的宿主能力应通过 Electron preload/channel 适配

## Verification

- `node scripts/check-bridge-domain-parity.mjs`
- 调用成功路径
- 超时路径
- 宿主报错路径
- 返回值归一化路径
