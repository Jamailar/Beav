---
doc_type: plan
execution_status: in_progress
last_updated: 2026-05-03
---

# Thrive 插件系统完整执行方案

## 1. 文档目标

本文定义 Thrive 桌面端支持“可安装插件”的完整产品与工程方案。

目标不是只做一个插件列表页，而是把插件系统做成 Thrive 的长期扩展底座：

- 插件可以扩展 AI 写作、知识库、采集、视频处理、导入导出和第三方服务连接。
- 插件不能绕过 RedBox 的权限、工具规划、任务队列、用户确认和持久化边界。
- 插件能力进入现有 runtime / MCP / skill / tool action 体系，而不是新增一个不可控的并行执行系统。
- UI 扩展保持克制，只开放固定 slot，不允许第三方插件改主导航、注入全局样式或替换核心页面。
- 安装、更新、卸载、启用、禁用、权限变更、运行时加载、错误诊断和发布分发都必须可验证。

本方案综合三类参考：

- RedBox 当前架构：Tauri host、React renderer、AI runtime、`skills`、`mcp`、`tools`、`media_runtime`、`redbox_editor`。
- Obsidian 插件生态：固定扩展点、命令系统、设置页、市场分发、用户可理解的启用/禁用模型。
- Codex 插件架构：插件作为 `skills + MCP servers + apps/connectors` 能力包，由 loader 归并为模型可见 capability summary。

最终推荐模型：

```text
RedBox Plugin
= manifest
+ skills
+ MCP servers
+ app/data connectors
+ typed actions
+ media job presets/processors
+ sandbox UI slots
+ capability permissions
```

插件不是 agent，也不是任意脚本执行器。插件只声明能力；执行永远由 RedBox host 通过明确的 action、job、MCP、approval 和 sandbox 边界完成。

## 2. 设计原则

### 2.1 产品原则

- 用户安装插件后，应能明确看到插件提供了什么能力、需要哪些权限、会不会联网、会不会改稿件或处理媒体。
- 插件能力优先进入命令 / action / AI skill，不优先加 UI。
- 插件 UI 只能服务配置、预览、导入、检查和少量辅助操作；不能把主产品变成插件面板集合。
- 插件更新不能静默安装。高风险权限变化必须重新授权。
- 官方插件、社区插件、本地开发插件使用同一套包格式和运行时，只在信任等级、签名、市场来源和默认策略上区分。

### 2.2 工程原则

- Renderer 不直接加载任意插件代码到主 React tree。
- Host 不允许插件直接读写 SQLite、workspace store、API key 明文或 runtime 内存。
- 插件文件路径必须全部限制在插件根目录或 `pluginData/<pluginId>/`。
- 插件贡献的工具能力必须进入现有 canonical action 体系，不能新增业务顶层 tool。
- 插件贡献的 MCP server 必须进入现有 MCP manager 和 per-tool policy。
- 视频插件必须提交 media job 或 preset，不能直接操作 timeline 内存。
- 所有安装、升级、卸载使用原子文件操作，失败可回滚。
- 首屏只加载插件摘要，不启动插件 runtime。

## 3. 与参考系统的取舍

### 3.1 从 Obsidian 学什么

Obsidian 值得学习的是生态体验：

- 插件有简单 manifest。
- 插件可被安装、启用、禁用、卸载、更新。
- 插件有固定扩展点，例如 command、settings、view。
- 用户可以从插件市场浏览、安装、管理。
- 插件能力经常先进入命令面板，而不是直接塞满 UI。

RedBox 不应学习 Obsidian 的权限模型。Obsidian 社区插件基本继承 App 权限，插件可以访问本机文件、联网、安装额外程序。RedBox 涉及 AI、知识库、稿件、素材、导出、发布和 API key，这种模型风险过高。

### 3.2 从 Codex 学什么

Codex 的核心价值是“插件即能力包”：

- 插件 manifest 固定在 `.codex-plugin/plugin.json`。
- 插件可贡献 `skills`、MCP server 和 apps/connectors。
- 插件 loader 输出 `effective_skill_roots`、`effective_mcp_servers`、`effective_apps` 和 capability summaries。
- 模型上下文只展示插件能力摘要，并提示“插件不能直接调用，要使用其底层 skills / MCP / apps”。
- 插件市场支持 local / git / remote source、install policy 和 auth policy。
- 插件安装进入版本化 cache，并使用 staged copy + rename 的原子激活方式。

RedBox 应直接采用这类能力包模型，但在其上增加：

- RedBox 专用权限 capability。
- 视频 / 音频 / 封面 / 字幕处理 job schema。
- 稿件和编辑器当前对象绑定。
- UI slot sandbox。
- 第三方服务联网域名白名单。

### 3.3 RedBox 自己必须自研什么

- 插件权限模型和 enforcement。
- 插件 action 到 `app_cli` / `redbox_editor` / `redbox_fs` 的映射。
- 媒体 job / preset / processor 协议。
- sandbox UI bridge。
- 插件安装安全校验、签名和风险提示。
- 插件 marketplace manifest 与发布链路。
- 插件运行事件、诊断和验证工具。

## 4. 插件包格式

### 4.1 文件后缀

插件分发包使用：

```text
*.rbxplugin
```

文件本质是 zip。安装时解压到临时目录，校验后进入插件 cache。

### 4.2 插件目录结构

```text
example-plugin/
├── .redbox-plugin/
│   └── plugin.json
├── skills/
│   └── xhs-writer/
│       └── SKILL.md
├── actions.json
├── mcp.json
├── apps.json
├── media.json
├── ui/
│   ├── settings/
│   │   └── index.html
│   └── manuscript-sidebar/
│       └── index.html
├── assets/
│   ├── icon.png
│   ├── logo.png
│   └── screenshots/
├── README.md
└── LICENSE
```

### 4.3 manifest 示例

```json
{
  "name": "xhs-writer",
  "version": "1.0.0",
  "description": "小红书内容创作和改稿插件",
  "minAppVersion": "1.12.0",
  "platforms": ["macos", "windows"],
  "skills": "./skills",
  "mcpServers": "./mcp.json",
  "apps": "./apps.json",
  "actions": "./actions.json",
  "media": "./media.json",
  "ui": {
    "settings": "./ui/settings/index.html",
    "manuscriptSidebar": "./ui/manuscript-sidebar/index.html"
  },
  "permissions": {
    "capabilities": [
      "ai.skill",
      "knowledge.read",
      "manuscripts.read",
      "manuscripts.write.current",
      "network.request.scoped"
    ],
    "network": ["api.example.com"],
    "approvalRequired": [
      "manuscripts.write.current",
      "export.publish"
    ]
  },
  "interface": {
    "displayName": "小红书写作助手",
    "shortDescription": "选题、改稿、标题和笔记结构优化",
    "longDescription": "为当前稿件、知识库素材和平台笔记结构提供写作辅助。",
    "developerName": "RedBox",
    "category": "Writing",
    "capabilities": ["写稿", "改稿", "标题生成"],
    "defaultPrompt": [
      "帮我把当前稿件改成小红书风格",
      "基于知识库生成 5 个选题",
      "优化当前笔记标题和开头"
    ],
    "logo": "./assets/logo.png"
  }
}
```

### 4.4 manifest 校验规则

必须校验：

- `name` 只能包含 ASCII 字母、数字、`-`、`_`。
- `version` 只能包含 ASCII 字母、数字、`.`、`+`、`-`、`_`，不能是 `.` 或 `..`。
- 所有路径必须以 `./` 开头。
- 所有路径不能包含 `..`。
- 所有路径必须解析到插件根目录内。
- `defaultPrompt` 最多 3 条，每条最多 128 个字符。
- `network` 域名必须是 hostname，不允许 `*`、URL path 或 IP 段通配。
- `permissions.capabilities` 只能取 RedBox 已知 capability。
- `ui` slot 只能取 RedBox 已知 slot。
- 缺失或非法 manifest 的插件不能启用。

## 5. 权限模型

### 5.1 权限分层

权限分为四层：

```text
Capability
  插件声明它需要的能力，例如 knowledge.read。

Scope
  能力适用的对象范围，例如 current manuscript、pluginData、workspace virtual resource。

Approval
  高风险动作是否需要用户确认。

Runtime Enforcement
  host 在 action / MCP / media job / UI bridge 层强制检查。
```

权限不是只展示给用户看，必须在执行层强制生效。

### 5.2 第一批可开放权限

```text
ai.skill
mcp.server
app.connector
knowledge.read
knowledge.import
manuscripts.read
manuscripts.write.current
editor.read.current
editor.write.current
media.read
media.import
media.process
video.exportPreset
video.effectPreset
subtitle.stylePreset
audio.processor
cover.template
export.create
network.request.scoped
pluginData.read
pluginData.write
ui.settingsPanel
ui.manuscriptSidebar
ui.videoInspectorPanel
```

### 5.3 高风险权限

这些权限可以设计，但默认不在社区插件第一版开放：

```text
filesystem.read.external
filesystem.write.external
network.request.any
sidecar.execute
shell.execute
manuscripts.overwrite
media.delete
export.publish
account.oauth
```

若必须开放，规则是：

- manifest 显式声明。
- 安装时强提示。
- 首次执行时二次确认。
- 更新后权限有变化必须重新授权。
- 运行事件必须记录插件、动作、目标资源、结果和用户确认记录。

### 5.4 禁止权限

这些能力不开放：

```text
database.raw
apiKeys.readPlaintext
settings.rawWrite
prompt.globalOverride
toolRegistry.globalOverride
ui.globalCss
ui.mainNavigationInject
runtime.directAgentSpawn
```

插件如果需要类似能力，必须通过 RedBox 提供的更窄 action 完成。

## 6. 插件类型与开放能力

### 6.1 AI Skill 插件

用途：

- 写稿风格。
- 选题分析。
- 平台文案。
- 品牌语气。
- 知识库总结。
- 稿件审校。

实现方式：

- 插件贡献 `skills/<skill>/SKILL.md`。
- loader 将 skill root 合并进现有 skill discovery。
- runtime 根据当前页面 / runtime mode / explicit plugin mention 决定是否注入。
- skill 只能引用 canonical tools 和 canonical actions。

必须自研：

- 插件 skill namespace，例如 `xhs-writer:rewrite-current-manuscript`。
- 插件 skill 启用/禁用规则。
- 插件 skill 与当前稿件绑定逻辑。
- 插件 capability summary 注入 prompt 的格式。

可以复用：

- 当前 `desktop/src-tauri/src/skills/*`。
- 当前 `desktop/src-tauri/src/tools/plan.rs` / `packs.rs` / `catalog.rs`。

### 6.2 MCP 插件

用途：

- 连接外部服务。
- 调第三方 API。
- 复杂数据读取。
- OAuth 服务。

实现方式：

- 插件贡献 `mcp.json`。
- 安装后 loader 合并到现有 MCP server config。
- MCP policy 使用 RedBox 现有 `approvalMode`、`enabledTools`、`disabledTools`、`perTool`、`toolTimeoutMs`。
- 插件 MCP tool 仍通过现有 MCP manager 执行。

必须自研：

- 插件 MCP server name 命名空间。
- 插件卸载后 MCP 清理。
- 插件更新后 MCP refresh。
- 插件 MCP OAuth 状态展示。

可以复用：

- `desktop/src-tauri/src/mcp/config.rs`
- `desktop/src-tauri/src/mcp/manager.rs`
- `desktop/src-tauri/src/mcp/tool_inventory.rs`
- `desktop/src-tauri/src/mcp/tool_exposure.rs`

### 6.3 App / Data Connector 插件

用途：

- Notion。
- 飞书。
- Google Drive。
- 语雀。
- CMS。
- OSS。
- 社媒平台。

实现方式：

- 插件贡献 `apps.json`。
- connector 不直接操作 RedBox store。
- connector 通过 `knowledge.import`、`manuscripts.create`、`media.import`、`export.create` 这类 action 进入宿主。

必须自研：

- RedBox connector schema。
- OAuth / API key 的安全存储。
- connector auth status。
- connector import preview。

可以复用：

- Codex 的 apps/connectors 组织思路。
- RedBox 现有 knowledge / media / manuscripts IPC 和 persistence。

### 6.4 Video / Media 插件

用途：

- 导出预设。
- FFmpeg filter preset。
- Remotion 模板。
- 字幕样式。
- 音频处理。
- 封面模板。
- 素材分析。
- B-roll 匹配。

实现方式：

- 插件贡献 `media.json`。
- 插件只声明 preset、processor、template、job schema。
- 执行时创建 `media.process` 或 `editor.workflow` job。
- job 进入 RedBox media runtime，由 host 管理进度、取消、日志和错误。

必须使用现成库：

- FFmpeg：转码、抽帧、滤镜、音视频处理。
- Remotion：模板化视频渲染。
- ASR：优先外部 API 或成熟本地引擎，不手写识别。
- libvips / ImageMagick：图片缩放、封面处理、格式转换。

必须自研：

- RedBox media job schema。
- 素材引用协议。
- 插件 processor permission。
- job queue 与 cancellation。
- job artifact cache。
- timeline 写入审查。

禁止：

- 插件直接改 video editor store。
- 插件直接写 timeline 内存。
- 插件直接写媒体库数据库。

### 6.5 UI 插件

用途：

- 插件设置页。
- 稿件侧栏辅助。
- 视频检查面板。
- 导入预览面板。
- 导出辅助面板。

允许 slot：

```text
settingsPanel
manuscriptSidebar
videoInspectorPanel
exportPanelAddon
knowledgeImporterPanel
commandPaletteCommand
```

禁止：

```text
mainNavigation
globalCss
replacePage
directDomInjection
rootReactComponent
```

实现方式：

- UI 用 sandbox iframe 或 Tauri isolated WebView。
- 插件 UI 通过 typed bridge 请求 host action。
- host 检查插件权限后执行。
- UI 只能读取当前 slot 允许的上下文摘要。

UI 原则：

- 第一版插件管理页只提供安装、启用、禁用、权限、详情、卸载、测试连接。
- 不做复杂市场首页。
- 不为每个插件创建导航入口。
- 不把说明文案塞进主工作流。

## 7. Host 模块设计

新增目录：

```text
desktop/src-tauri/src/plugins/
├── mod.rs
├── manifest.rs
├── marketplace.rs
├── store.rs
├── installer.rs
├── loader.rs
├── permissions.rs
├── runtime.rs
├── skills.rs
├── mcp.rs
├── apps.rs
├── media.rs
├── ui.rs
└── events.rs
```

### 7.1 `manifest.rs`

职责：

- 读取 `.redbox-plugin/plugin.json`。
- 解析 manifest。
- 校验路径、版本、权限、平台、UI slot。
- 输出 normalized `PluginManifest`。

核心类型：

```rust
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub min_app_version: Option<String>,
    pub platforms: Vec<PluginPlatform>,
    pub paths: PluginManifestPaths,
    pub permissions: PluginPermissionDeclaration,
    pub interface: Option<PluginInterface>,
}
```

### 7.2 `store.rs`

职责：

- 管理插件 cache。
- 原子安装。
- 原子升级。
- 卸载。
- 查询 active version。

路径：

```text
~/Library/Application Support/RedBox/plugins/cache/<marketplace>/<plugin>/<version>/
~/Library/Application Support/RedBox/plugins/data/<pluginId>/
~/Library/Application Support/RedBox/plugins/index.json
```

安装规则：

```text
extract to temp
validate manifest
validate package files
stage copy
backup existing
rename staged to active
rollback on failure
write index
emit event
```

### 7.3 `marketplace.rs`

职责：

- 读取 marketplace manifest。
- 支持 official / local / git。
- 展示插件列表。
- 解析 install/auth policy。

第一版 marketplace：

```json
{
  "name": "redbox-official",
  "interface": {
    "displayName": "RedBox Official"
  },
  "plugins": [
    {
      "name": "xhs-writer",
      "source": {
        "type": "local",
        "path": "./plugins/xhs-writer"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_USE"
      },
      "category": "Writing"
    }
  ]
}
```

### 7.4 `loader.rs`

职责：

- 从 enabled plugins 加载能力。
- 输出 `PluginLoadOutcome`。
- 合并 skill roots、MCP servers、apps、actions、media extensions、UI slots。
- 生成模型可见 capability summary。

核心输出：

```rust
pub struct PluginLoadOutcome {
    pub plugins: Vec<LoadedPlugin>,
    pub skill_roots: Vec<PathBuf>,
    pub mcp_servers: HashMap<String, McpServerRecord>,
    pub apps: Vec<PluginAppConnector>,
    pub actions: Vec<PluginActionDescriptor>,
    pub media_extensions: Vec<PluginMediaExtension>,
    pub ui_slots: Vec<PluginUiSlot>,
    pub capability_summaries: Vec<PluginCapabilitySummary>,
}
```

### 7.5 `permissions.rs`

职责：

- 校验 manifest permissions。
- 安装时生成 effective policy。
- 执行时检查 capability。
- 高风险动作触发 approval。
- 记录审计事件。

必须提供：

```rust
pub fn assert_plugin_capability(
    plugin_id: &PluginId,
    capability: PluginCapability,
    target: PluginTarget,
) -> Result<(), PluginPermissionError>;
```

### 7.6 `runtime.rs`

职责：

- 管理插件生命周期。
- 懒加载插件 runtime。
- 启动 / 停止 MCP。
- 启动 / 停止 sidecar。
- 清理过期缓存。
- 统一诊断状态。

策略：

- App 启动只读 manifest 和 index。
- 插件在首次使用时才启动 runtime。
- 插件 runtime 有启动超时、执行超时、并发限制和日志截断。

### 7.7 `media.rs`

职责：

- 解析 `media.json`。
- 注册 video/audio/subtitle/cover preset。
- 将插件 processor 转成 media job。
- 校验输入输出 artifact。

禁止在这里直接改 UI 状态。媒体变更必须通过现有 media runtime / editor action 应用。

### 7.8 `ui.rs`

职责：

- 管理 UI slot。
- 生成 sandbox URL。
- 提供 typed bridge。
- 检查 UI 请求权限。

UI bridge 请求示例：

```json
{
  "id": "req_123",
  "action": "manuscripts.writeCurrent",
  "payload": {
    "body": "..."
  }
}
```

host 必须附加：

```json
{
  "pluginId": "xhs-writer@redbox-official",
  "slot": "manuscriptSidebar",
  "currentContext": {
    "manuscriptId": "..."
  }
}
```

插件不能自己声明目标稿件绕过当前对象绑定。

## 8. Renderer 模块设计

新增目录：

```text
desktop/src/features/plugins/
├── types.ts
├── pluginApi.ts
├── pluginStore.ts
├── PluginList.tsx
├── PluginDetail.tsx
├── PluginPermissionDialog.tsx
├── PluginSandboxFrame.tsx
└── PluginStatusBadge.tsx
```

设置页接入：

```text
desktop/src/pages/settings/SettingsSections.tsx
desktop/src/pages/Settings.tsx
```

Bridge 接入：

```text
desktop/src/bridge/ipcRenderer.ts
```

### 8.1 插件管理页

第一版只做以下功能：

- 已安装插件列表。
- 本地安装 `.rbxplugin`。
- 启用 / 禁用。
- 查看详情。
- 查看权限。
- 测试连接。
- 卸载。
- 打开插件数据目录。

不做：

- 大型市场首页。
- 插件推荐瀑布流。
- 插件排行榜。
- 插件内联教程。

### 8.2 插件详情页

展示：

- 名称、版本、来源、开发者。
- 描述。
- 能力摘要。
- 权限列表。
- 需要用户确认的动作。
- MCP server 状态。
- app connector 授权状态。
- skill 列表和启用状态。
- 错误诊断。

### 8.3 插件 UI slot

宿主页面只提供 slot 容器：

- 稿件页右侧侧栏。
- 视频页检查面板。
- 设置页插件配置区。
- 导入预览弹窗。

slot 加载规则：

- 只在用户进入相关页面且插件启用时加载。
- slot 首屏先渲染 shell。
- 插件 iframe 懒加载。
- 插件崩溃只影响自己的 slot。

## 9. IPC 设计

新增 IPC channels：

```text
plugins:list
plugins:read
plugins:install
plugins:uninstall
plugins:enable
plugins:disable
plugins:update-permissions
plugins:reload
plugins:test
plugins:open-data-dir
plugins:marketplace-list
plugins:marketplace-add
plugins:marketplace-remove
plugins:marketplace-refresh
plugins:ui-call
```

所有 renderer 调用必须通过：

```text
desktop/src/bridge/ipcRenderer.ts
```

不要在页面直接使用 Tauri `invoke()`。

## 10. AI Runtime 接入

### 10.1 模型可见摘要

插件启用后，runtime context 增加一段类似：

```text
## Available Plugins

- xhs-writer: 小红书写作助手。提供写稿 skill、当前稿件改写 action、标题生成 action。

How to use plugins:
- Plugins are not invoked directly.
- Use the underlying RedBox actions, skills, MCP tools, or app connectors exposed by the plugin.
- Prefer plugin capabilities when the user explicitly mentions the plugin or when the current task matches its capability summary.
```

摘要必须短。不能把完整 manifest 塞进 prompt。

### 10.2 ToolRouter 接入

插件 action 不新增顶层 tool。它们进入：

```text
app_cli action registry
redbox_editor action registry
redbox_fs virtual resource registry
```

示例：

```text
plugin.xhsWriter.rewriteCurrent
plugin.xhsWriter.generateTitles
plugin.videoPreset.applyExportPreset
```

是否暴露给模型由每轮 ToolRouter 决定：

- 当前页面。
- 当前 runtime mode。
- 当前绑定对象。
- 用户是否显式提到插件。
- 插件权限。
- action 风险等级。

### 10.3 当前对象绑定

在稿件页或视频编辑页，插件 action 必须强绑定当前对象：

```text
manuscripts://current
editor://current/script
editor://current/timeline
media://current-selection
```

模型和插件都不能传任意稿件 ID 绕过当前页面上下文，除非用户在全局管理页显式选择批处理。

## 11. 安装、更新、卸载流程

### 11.1 本地安装

```text
用户选择 .rbxplugin
host 解压到 temp
校验 zip 内容
读取 manifest
校验路径和权限
展示权限确认
原子安装到 cache
写 index
刷新 loader
刷新 MCP / skills / apps
发 plugins:changed 事件
```

### 11.2 市场安装

```text
读取 marketplace
用户打开 plugin detail
host 下载 source
校验 sha / signature
校验 manifest
展示权限确认
安装
如 authentication=ON_INSTALL，启动授权
刷新能力
```

### 11.3 更新

```text
检查 marketplace version
比较 manifest 权限
若权限增加或风险等级变高，要求重新确认
下载新版本
原子替换
失败回滚旧版本
刷新能力
```

默认不自动更新。可以提示有更新，但执行必须由用户确认。

### 11.4 卸载

```text
禁用插件
停止 runtime / MCP / sidecar
移除 enabled config
删除 cache/<pluginId>
保留或询问删除 pluginData/<pluginId>
刷新能力
发 plugins:changed
```

删除语义必须清晰。卸载后不能仍在已安装列表中伪装为 disabled。

## 12. 数据与配置

### 12.1 插件索引

```text
Application Support/RedBox/plugins/index.json
```

示例：

```json
{
  "schemaVersion": 1,
  "plugins": {
    "xhs-writer@redbox-official": {
      "enabled": true,
      "activeVersion": "1.0.0",
      "marketplace": "redbox-official",
      "installedAt": "2026-05-03T00:00:00Z",
      "updatedAt": "2026-05-03T00:00:00Z",
      "permissions": {
        "granted": ["ai.skill", "manuscripts.write.current"],
        "denied": []
      }
    }
  }
}
```

### 12.2 插件数据目录

```text
Application Support/RedBox/plugins/data/<pluginId>/
├── settings.json
├── cache/
├── logs/
└── state/
```

插件只能访问自己的 data 目录，且必须通过 host API。

## 13. 性能策略

- App 启动只读 `index.json` 和 manifest summary。
- 不在启动时拉起 MCP、sidecar 或 UI。
- 插件市场列表分页和缓存。
- 插件详情按需读取。
- 插件 assets 缩略图懒加载。
- 插件技能扫描缓存 hash。
- MCP server 懒启动，且有 startup timeout。
- sidecar 有最大并发、空闲回收和日志截断。
- media job 使用后台队列，不阻塞页面 IPC。
- 大文件只传引用，不通过 IPC 传 blob。
- 插件 UI slot 独立加载，崩溃不影响主页面。
- 插件 action 输出必须有字符预算和结构化摘要。

## 14. 安全策略

### 14.1 文件安全

- zip 解压必须防 zip slip。
- symlink 默认拒绝。
- 路径必须 canonicalize 后确认仍在插件根目录。
- 插件安装目录不允许世界可写。
- Windows 路径必须使用 safe stem 规则。

### 14.2 网络安全

- 默认禁止任意网络。
- `network.request.scoped` 只能访问 manifest 声明域名。
- 不允许插件自己声明 `localhost` 任意端口，除非是自身 MCP/sidecar 端口且由 host 分配。
- 网络请求由 host proxy 执行并记录。

### 14.3 密钥安全

- 插件不能读取 API key 明文。
- OAuth / token 存储走 host secret store。
- 插件只能请求“代表插件调用某 connector”，不能拿到 token。

### 14.4 AI 安全

- 插件 skill 不能覆盖全局 system prompt。
- 插件 prompt 只能作为 skill context 注入。
- 插件 action schema 必须固定。
- 插件不能在 tool 内部再启动 agent。
- 高风险 action 需要 approval。

## 15. 方案对比

| 方案 | 优点 | 问题 | 结论 |
|---|---|---|---|
| Obsidian 式 JS 插件 | 生态门槛低，UI 灵活 | 权限过宽，安全风险高，容易污染主 UI | 不采用 |
| MCP-only 插件 | 简单、安全、和 AI 兼容 | 做不了 UI、视频 preset、导入导出完整体验 | 作为子能力采用 |
| Codex 能力包插件 | 适合 AI、MCP、skills、apps，架构清晰 | 需要补 RedBox 权限和媒体协议 | 作为主模型 |
| Sidecar 插件 | 适合视频、Python/Node 工具、复杂处理 | 生命周期、安全、安装复杂 | 只对高阶媒体/连接器开放 |
| WASM 插件 | 安全、可控、跨平台 | 生态和媒体能力不足 | 可作为后续轻计算插件 |
| RedBox capability 插件 | 最贴合产品边界 | 需要自研较多 host 代码 | 推荐最终方案 |

推荐：

```text
Codex 能力包模型
+ Obsidian 固定扩展点体验
+ RedBox capability 权限
+ MCP / sidecar / sandbox UI 分层
+ media job / preset 协议
```

## 16. 执行计划

本计划应作为一条完整交付线完成，但提交必须保持 atomic。每个提交只做一件事。

### Commit 1: 插件 manifest 与类型基础

新增：

```text
desktop/src-tauri/src/plugins/mod.rs
desktop/src-tauri/src/plugins/manifest.rs
desktop/src-tauri/src/plugins/permissions.rs
```

完成：

- `PluginId`。
- `PluginManifest`。
- manifest 路径校验。
- capability enum。
- UI slot enum。
- manifest 单元测试。

验收：

- 非法路径被拒绝。
- 非法 name/version 被拒绝。
- 未知 capability 被拒绝。
- `./` 内路径解析成功。

### Commit 2: 插件 store 与原子安装

新增：

```text
desktop/src-tauri/src/plugins/store.rs
desktop/src-tauri/src/plugins/installer.rs
```

完成：

- cache 路径。
- versioned install。
- staged copy。
- backup + rollback。
- uninstall。
- `index.json` 读写。

验收：

- 安装成功后 active version 可查询。
- 安装失败可保留旧版本。
- 卸载删除 cache。
- 不删除无关 pluginData。

### Commit 3: 插件 loader 与 capability summary

新增：

```text
desktop/src-tauri/src/plugins/loader.rs
desktop/src-tauri/src/plugins/skills.rs
desktop/src-tauri/src/plugins/mcp.rs
desktop/src-tauri/src/plugins/apps.rs
```

完成：

- 加载 enabled plugins。
- 输出 skill roots。
- 输出 MCP server config。
- 输出 app connector config。
- 输出 capability summaries。
- 跳过 disabled / invalid plugin。

验收：

- disabled plugin 不进入 effective outcome。
- invalid plugin 记录 error。
- capability summary 不超过预算。
- duplicate MCP server name 有确定性处理。

### Commit 4: IPC 与插件管理基础 UI

新增：

```text
desktop/src/features/plugins/*
```

修改：

```text
desktop/src/bridge/ipcRenderer.ts
desktop/src/pages/settings/SettingsSections.tsx
desktop/src/pages/Settings.tsx
```

完成：

- `plugins:list`
- `plugins:read`
- `plugins:install`
- `plugins:uninstall`
- `plugins:enable`
- `plugins:disable`
- 插件设置页入口。

验收：

- 设置页首屏不等待慢扫描。
- 插件列表 stale-while-revalidate。
- 安装/卸载/启用/禁用可见。
- 刷新失败保留旧列表。

### Commit 5: MCP 和 Skill 运行时接入

修改：

```text
desktop/src-tauri/src/mcp/*
desktop/src-tauri/src/skills/*
desktop/src-tauri/src/runtime/*
```

完成：

- 插件 MCP 合并进 MCP manager。
- 插件 skill roots 合并进 skill discovery。
- runtime context 注入 available plugin summaries。
- 插件更新后触发 MCP refresh。

验收：

- 安装带 MCP 的插件后能 list tools。
- 禁用插件后 MCP tool 不再可见。
- 安装带 skill 的插件后 runtime 可识别。
- 模型上下文只包含摘要，不泄漏完整 manifest。

### Commit 6: Plugin Actions 接入 ToolRouter

新增：

```text
desktop/src-tauri/src/plugins/actions.rs
```

修改：

```text
desktop/src-tauri/src/tools/catalog.rs
desktop/src-tauri/src/tools/plan.rs
desktop/src-tauri/src/tools/app_cli.rs
desktop/src-tauri/src/tools/compat.rs
```

完成：

- 解析 `actions.json`。
- 插件 action namespace。
- 按 runtime mode 暴露。
- 按权限检查执行。
- 高风险 action 走 approval。

验收：

- action schema-first。
- 未授权 action 被拒绝。
- 当前稿件 action 强绑定 `manuscripts://current`。
- 普通 runtime 不继承 diagnostics 宽权限。

### Commit 7: Media / Video 插件协议

新增：

```text
desktop/src-tauri/src/plugins/media.rs
```

修改：

```text
desktop/src-tauri/src/media_runtime/*
desktop/src-tauri/src/tools/families/*
desktop/src-tauri/src/tools/catalog.rs
```

完成：

- `media.json` schema。
- export preset。
- ffmpeg filter preset。
- remotion template。
- subtitle style preset。
- media analyzer job。
- processor permission。

验收：

- 插件只能创建 media job。
- job 可取消。
- job 日志可查看。
- 插件不能直接写 timeline store。

### Commit 8: Sandbox UI Slot

新增：

```text
desktop/src-tauri/src/plugins/ui.rs
desktop/src/features/plugins/PluginSandboxFrame.tsx
```

完成：

- settings panel slot。
- manuscript sidebar slot。
- typed postMessage bridge。
- host-side permission check。
- 插件 UI 崩溃隔离。

验收：

- 插件 UI 不能访问主 React state。
- 插件 UI 请求未授权 action 被拒绝。
- slot 页面切换不阻塞首屏。
- 插件崩溃只显示 slot 内错误。

### Commit 9: Marketplace

新增：

```text
desktop/src-tauri/src/plugins/marketplace.rs
```

完成：

- local marketplace。
- official marketplace manifest。
- git source metadata。
- install policy。
- auth policy。
- marketplace refresh。

验收：

- marketplace load error fail-open 展示。
- `NOT_AVAILABLE` 插件不可安装。
- `INSTALLED_BY_DEFAULT` 可被标识。
- `ON_INSTALL` / `ON_USE` 可展示。

### Commit 10: 安全、诊断和验证工具

新增：

```text
desktop/src-tauri/src/plugins/events.rs
desktop/docs/plugin-authoring-guide.md
desktop/docs/plugin-security-model.md
```

完成：

- runtime events。
- install diagnostics。
- plugin test command。
- plugin logs。
- authoring guide。
- security model doc。

验收：

- 安装失败有明确错误。
- runtime 失败可定位插件。
- MCP 启动失败可定位 server。
- media job 失败可定位 processor。

## 17. 验证矩阵

### 17.1 Rust 单元测试

覆盖：

- manifest parse。
- path validation。
- version validation。
- permission validation。
- store atomic install。
- loader disabled plugin。
- loader invalid plugin。
- action permission。
- media schema。

命令：

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml plugins
```

### 17.2 TypeScript 检查

```bash
pnpm --dir desktop exec tsc --noEmit
```

### 17.3 Host 检查

```bash
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
cargo check --manifest-path desktop/src-tauri/Cargo.toml
```

### 17.4 真实调用验证

必须验证：

- 从设置页安装本地 `.rbxplugin`。
- 启用插件后列表刷新。
- 禁用插件后能力消失。
- 带 skill 插件能进入 AI runtime。
- 带 MCP 插件能列出 tools。
- 带 media preset 插件能创建 job。
- 带 UI slot 插件能加载 sandbox。
- 卸载插件后 cache 被删除，能力消失。

### 17.5 回归验证

必须确认：

- 现有浏览器 `Plugin/` 打包不受影响。
- 现有 knowledge import 不受影响。
- 现有 manuscript editor 页内 AI 不被插件抢工具。
- 现有 video editor 导出不受插件 preset 影响。
- 设置页刷新失败不清空插件列表。

## 1.1 当前落地状态

截至 2026-05-03，已落地的第一版能力：

- 本地插件目录 / `.rbxplugin` / `.zip` 安装。
- 插件启用、停用、卸载和数据目录打开。
- manifest 路径、权限、网络 host、主页扩展字段校验。
- 插件 skill 同步到现有 skill catalog。
- 插件 MCP server 同步到现有 MCP store，并加插件命名空间。
- `plugins:read-data` 受控数据读取，覆盖知识库、稿件、媒体和资产摘要。
- `plugins:home` 主页扩展聚合，支持 widgets、quick actions、sidebar sections。
- 主页 React 已渲染 manifest 声明的受控 widget，不执行第三方 JS。

仍未完成的能力：

- marketplace / 远程更新。
- 插件签名和权限变更重新授权。
- sandbox iframe UI slot。
- `actions.json` 执行协议。
- `media.json` job / preset 执行协议。

## 18. 文档交付

实现完成时至少补齐：

```text
desktop/docs/plugin-authoring-guide.md
desktop/docs/plugin-security-model.md
desktop/docs/ipc-inventory.md
```

`plugin-authoring-guide.md` 必须包含：

- 插件结构。
- manifest 字段。
- permissions。
- actions。
- media presets。
- MCP。
- UI slots。
- 打包方式。
- 本地安装方式。

`plugin-security-model.md` 必须包含：

- 权限列表。
- 禁止能力。
- 审批策略。
- 网络策略。
- 文件策略。
- 更新策略。

## 19. 风险与回滚

### 19.1 主要风险

- 插件权限声明和执行层不一致。
- 插件 action 过多导致模型工具选择下降。
- UI slot 失控导致页面臃肿。
- media processor 造成长任务阻塞。
- MCP server 名称冲突。
- 插件更新后权限变化未重新授权。

### 19.2 缓解策略

- 所有 action 都必须 schema-first。
- ToolRouter 每轮只暴露少量相关 action。
- 插件 UI 默认隐藏在已有页面 slot。
- media job 强制后台队列。
- MCP server 自动加 plugin namespace。
- 权限 hash 变化触发重新授权。

### 19.3 回滚策略

- 全局 feature flag：`plugins.enabled=false`。
- 单插件 disable。
- 插件版本回滚到上一 active version。
- MCP refresh 可跳过 plugin servers。
- UI slot 可独立关闭。
- media plugin processors 可禁用但保留 presets。

## 20. 最终完成标准

插件系统可以判定完成，必须满足：

- 用户能安装、启用、禁用、卸载本地插件。
- 插件 manifest、权限和路径校验完整。
- 插件可贡献 skill、MCP server、action、media preset 和 UI slot。
- 插件 action 走现有 RedBox canonical tool/action，不新增业务顶层 tool。
- 插件高风险动作需要用户确认。
- 插件 UI 被 sandbox 隔离。
- 插件媒体处理走 job queue。
- 插件更新不会静默扩大权限。
- 插件错误可诊断。
- 现有浏览器采集插件和桌面 release 打包链路不受破坏。
