---
doc_type: plan
execution_status: not_started
last_updated: 2026-05-13
---

# RedConvert Plugin System v2 Capability Pack Plan

## 1. Goal

RedConvert 当前插件系统已经支持安装、启用、禁用、卸载、市场读取、manifest 校验、skill 同步、MCP server 同步和首页小组件。由于插件系统还未正式发布，v2 应该允许 breaking change，把插件从“补充 skill / MCP / home widget 的包”升级为长期可扩展的能力平台。

v2 的兼容性原则：**RedConvert 插件协议必须是 Codex 插件协议的兼容超集**。也就是说，标准 Codex 插件应能原样安装、启用、同步能力和被 AI 使用；RedConvert 自己的 media job、workflow、template、UI slot 等能力只能作为扩展层存在，不能破坏 Codex 插件包格式。

目标架构：

```text
RedConvert Plugin
= Codex-compatible manifest
+ permissions
+ capability registry records
+ runtime adapters
+ AI skills
+ MCP servers/tools
+ actions
+ media jobs
+ data connectors
+ UI slots
+ template packs
+ workflows
+ provider extensions
```

插件不直接修改 RedConvert 内部 store、timeline、knowledge index、media catalog 或 renderer 主树。插件只声明能力；RedConvert host 负责权限、调度、任务、入库、日志、取消、回滚、诊断和 UI slot 边界。

本计划的第一个验收插件建议是 `youtube-import`：通过 `yt-dlp` 和 `ffmpeg` 导入 YouTube metadata、字幕、音频、视频，并写入媒体库 / 知识库。它能覆盖外部进程、联网、长任务、媒体入库、AI 工具、UI 入口和权限提示，是插件系统 v2 的最佳压力测试。

## 2. Non Goals

- 不做 Obsidian 式“插件直接继承 App 全权限并任意改 UI / store”。
- 不把 yt-dlp 或其他第三方二进制重新内置进主 App。
- 不为了某个平台做宿主层关键词特判，例如遇到“YouTube”就强制激活某个插件。
- 不新增大量顶层 LLM tool。插件能力应进入现有 `skills`、MCP、canonical action、media job 和 `tool_search` 体系。
- 不允许插件直接访问 `window.ipcRenderer` 全量能力。
- 不允许插件直接写 SQLite、workspace catalog、media assets、knowledge index 或 manuscript state。

## 3. Compatibility Target: Codex Plugins First

RedConvert v2 插件系统应先完整兼容 Codex 插件，再扩展 RedConvert 专用能力。

Official Codex plugin model to support:

```text
.codex-plugin/plugin.json
skills/
.app.json
.mcp.json
hooks/
assets/
```

The RedConvert loader must support these Codex plugin surfaces:

| Codex surface | RedConvert mapping |
|---|---|
| `.codex-plugin/plugin.json` | Accepted as a first-class manifest, not just fallback |
| `name` / `version` / display metadata | Plugin summary and marketplace metadata |
| `skills` | Skill catalog entries with plugin namespace |
| `mcpServers` / `.mcp.json` | MCP manager servers with plugin namespace, policy, timeout, approval |
| `apps` / `.app.json` | Connector/app integration metadata; initially diagnose or map only when RedConvert has a matching connector runtime |
| `hooks` / `hooks/hooks.json` | Restricted lifecycle hooks, not arbitrary host mutation |
| `assets` | Install-surface icons, logos, screenshots |

Future Codex surfaces:

- If Codex later formalizes plugin-contributed agents, commands, or workflows, RedConvert should add explicit compatibility mappings at that point.
- Until then, do not treat `agents` or `commands` as official Codex plugin surfaces.

Compatibility requirements:

- A Codex plugin repo or package should install without conversion when it contains `.codex-plugin/plugin.json`.
- A Codex plugin that only contributes `skills` must work, including relative reference files and scripts under the skill folder.
- A Codex plugin that contributes MCP servers must work through RedConvert's MCP manager.
- Codex plugin names must be namespaced before entering RedConvert stores to avoid collisions.
- RedConvert must not require `.redbox-plugin/plugin.json` for Codex-compatible plugins.
- RedConvert-specific fields should live under a RedConvert extension namespace, for example `redconvert`, `redbox`, or separate `entry` files.
- If a Codex plugin includes unsupported surfaces, installation should still succeed when the unsupported surface is optional; the plugin summary should show which contributions were ignored.

Recommended manifest handling:

```text
Codex plugin manifest
  -> parse as CodexPluginManifest
  -> normalize into PluginManifestV2
  -> preserve raw manifest for diagnostics
  -> register Codex-native capabilities
  -> register RedConvert extension capabilities if present
```

Do not fork the ecosystem by requiring third-party authors to repackage Codex plugins as RedConvert plugins. RedConvert-specific packaging can exist, but Codex plugin compatibility must be the lowest common denominator.

## 4. Recommended Architecture

```text
Plugin Marketplace
  -> Plugin Installer
  -> Manifest Validator
  -> Permission Resolver
  -> Plugin Registry
  -> Runtime Manager
      -> MCP Runtime Adapter
      -> Action Runtime Adapter
      -> Media Job Runtime Adapter
      -> Connector Runtime Adapter
      -> UI Slot Runtime Adapter
      -> Template Pack Adapter
      -> Workflow Adapter
  -> Consumers
      -> AI Skill Catalog
      -> MCP Manager
      -> Tool Router
      -> Media Runtime
      -> Knowledge Import
      -> Renderer Fixed UI Slots
```

模块建议：

```text
desktop/src-tauri/src/plugins/
  mod.rs
  manifest.rs
  installer.rs
  marketplace.rs
  registry.rs
  permissions.rs
  runtime.rs
  mcp.rs
  actions.rs
  media_jobs.rs
  connectors.rs
  ui_slots.rs
  templates.rs
  workflows.rs
  diagnostics.rs
```

其他模块只消费 `PluginRegistry` 的快照，不直接读插件目录：

```text
skills            -> registry.skill_roots()
mcp               -> registry.mcp_servers()
tools/router      -> registry.actions() + registry.mcp_tools()
media_runtime     -> registry.media_jobs()
knowledge         -> registry.connectors() / registry.importers()
renderer          -> registry.ui_slots() / marketplace summaries
```

## 5. Plugin Capability Types

v2 原生支持以下能力类型。

| Kind | Purpose | Examples |
|---|---|---|
| `skill` | 给 AI 提供领域能力说明和使用边界 | 小红书写作、YouTube 导入策略 |
| `mcpServer` | 暴露外部工具或第三方服务 | yt-dlp、Notion、RSS、发布平台 |
| `mcpTool` | MCP server 暴露出的具体结构化工具 | `youtube.fetchMetadata` |
| `action` | 用户、AI、UI、workflow 都能调用的统一入口 | 导入链接、生成字幕、导出平台格式 |
| `mediaJob` | 媒体导入、处理、生成、分析、导出 | YouTube 导入、FFmpeg 压缩、字幕转写 |
| `dataConnector` | 外部数据源接入和同步 | YouTube 频道、RSS、Google Drive |
| `uiSlot` | 固定位置、沙箱化、轻量交互 | 设置面板、导入面板、媒体详情侧栏 |
| `templatePack` | 纯数据资源包 | 封面模板、字幕样式、视频动效 |
| `workflow` | 可复用的结构化流程 | 导入视频 -> 转字幕 -> 总结 -> 入库 |
| `provider` | 模型或服务供应商扩展 | LLM、Embedding、ASR、TTS、图像生成 |

推荐 v2 首批完整开放：`skill`、`mcpServer`、`action`、`mediaJob`、`dataConnector`、`uiSlot`、`templatePack`、`workflow`。

`provider` 风险较高，可在 schema 中预留，v2.1 再开放市场安装。

## 6. Manifest v2

RedConvert-native plugins should use:

```text
.redbox-plugin/plugin.json
```

Codex-compatible plugins must also be first-class:

```text
.codex-plugin/plugin.json
```

Manifest search order:

```text
.redbox-plugin/plugin.json
.codex-plugin/plugin.json
.thrive-plugin/plugin.json
plugin.json
```

If `.codex-plugin/plugin.json` is found, parse it as a Codex manifest first, then normalize into RedConvert's internal v2 capability model.

示例：

```json
{
  "schemaVersion": 2,
  "id": "youtube-import",
  "name": "YouTube Import",
  "version": "1.0.0",
  "description": "Import YouTube metadata, subtitles, audio, and video into RedConvert.",
  "minAppVersion": "1.9.0",
  "platforms": ["macos", "windows"],
  "developer": {
    "name": "RedConvert",
    "url": "https://example.com"
  },
  "entry": {
    "skills": "./skills",
    "mcpServers": "./mcp.json",
    "actions": "./actions.json",
    "mediaJobs": "./media.json",
    "connectors": "./connectors.json",
    "ui": "./ui.json",
    "templates": "./templates.json",
    "workflows": "./workflows.json"
  },
  "runtime": {
    "kind": "mcp",
    "lazy": true
  },
  "permissions": {
    "capabilities": [
      "ai.skill",
      "mcp.server",
      "action.execute",
      "media.import",
      "media.write",
      "knowledge.import",
      "pluginData.read",
      "pluginData.write",
      "network.request.scoped",
      "external.process"
    ],
    "network": [
      "youtube.com",
      "youtu.be",
      "googlevideo.com",
      "ytimg.com"
    ],
    "approvalRequired": [
      "external.process",
      "media.write",
      "knowledge.import"
    ]
  },
  "interface": {
    "displayName": "YouTube Import",
    "category": "Media",
    "shortDescription": "Import videos, audio, subtitles, and metadata.",
    "logo": "./assets/logo.png"
  }
}
```

Validation rules:

- `schemaVersion` must be `2`.
- `id` must be stable and use ASCII letters, digits, `-`, `_`, or `.`.
- `version` must be semver-like and cannot be `.` or `..`.
- All manifest paths must start with `./`.
- Manifest paths must not contain `..`, absolute roots, symlinks, or unsafe archive paths.
- `permissions.capabilities` must be known capability ids.
- `permissions.network` must be hostnames only, not URLs, paths, wildcards, or IP ranges.
- `entry.*` files must match their schemas.
- `runtime.kind` must be one of the supported runtime kinds.
- `interface.defaultPrompt` should remain short if supported: max 3 items, max 128 chars each.

## 7. Permission Model

Permissions have four layers:

```text
Capability
  Declares what the plugin wants to do.

Scope
  Defines which object range the capability applies to.

Approval
  Decides whether user confirmation is required.

Runtime Enforcement
  Blocks execution if the plugin does not have the capability/scope/approval.
```

Recommended capability ids:

```text
ai.skill
mcp.server
action.execute

pluginData.read
pluginData.write

network.request.scoped
external.process

media.read
media.import
media.write
media.process
media.export
media.analyze

knowledge.read
knowledge.import
knowledge.write

manuscripts.read
manuscripts.write.current

editor.read.current
editor.write.current

ui.settings
ui.importPanel
ui.mediaInspector
ui.manuscriptSidebar
ui.homeWidget

template.cover
template.subtitle
template.motion
template.richPost

workflow.run

provider.llm
provider.embedding
provider.asr
provider.tts
provider.image
provider.video
```

High-risk capabilities:

```text
external.process
network.request.scoped
media.write
media.export
knowledge.write
knowledge.import
manuscripts.write.current
editor.write.current
provider.*
```

Permission upgrade rules:

- Same permissions: normal update allowed.
- New low-risk capability: show update notice.
- New high-risk capability: disable plugin until user re-authorizes.
- New `external.process`, `network.request.scoped`, `media.write`, or `knowledge.write/import`: always require explicit confirmation.

## 8. Capability Registry

`PluginRegistry` is the core v2 abstraction. Installer and enable/disable operations update the plugin index. Registry build turns enabled plugins into normalized capability records.

Suggested Rust shape:

```rust
pub struct PluginCapability {
    pub plugin_id: String,
    pub capability_id: String,
    pub kind: PluginCapabilityKind,
    pub title: String,
    pub description: Option<String>,
    pub input_schema: serde_json::Value,
    pub output_schema: serde_json::Value,
    pub permissions: Vec<String>,
    pub runtime: PluginRuntimeRef,
    pub source_path: Option<PathBuf>,
    pub metadata: serde_json::Value,
}

pub enum PluginCapabilityKind {
    Skill,
    McpServer,
    McpTool,
    Action,
    MediaJob,
    DataConnector,
    UiSlot,
    TemplatePack,
    Workflow,
    Provider,
}
```

Registry views:

```rust
registry.skills()
registry.mcp_servers()
registry.actions()
registry.media_jobs()
registry.connectors()
registry.ui_slots()
registry.templates()
registry.workflows()
registry.providers()
```

The registry should be snapshot-based:

- Build from enabled plugin index and validated manifests.
- Avoid starting plugin runtime during registry build.
- Include fingerprint for AI tool plan, diagnostics, and stale cache detection.
- Keep plugin root and plugin data path as owned snapshots.
- Do not hold store locks while scanning plugin files or loading schemas.

## 9. Runtime Model

Supported runtime kinds:

| Runtime | Use | v2 Recommendation |
|---|---|---|
| `none` | Pure data packs | Fully support |
| `mcp` | External tools through MCP | Fully support |
| `webview` | Sandboxed UI slot | Fully support |
| `node` | General plugin process | Reserve or restrict |
| `python` | General plugin process | Reserve or restrict |
| `external` | Arbitrary command | Only through explicit high-risk approval |

v2 should officially support `none`, `mcp`, and `webview` first. `node` and `python` can be implementation details for packaged MCP servers, not general unrestricted plugin runtimes.

For MCP stdio servers, host should inject:

```text
REDCONVERT_PLUGIN_ID
REDCONVERT_PLUGIN_NAME
REDCONVERT_PLUGIN_ROOT
REDCONVERT_PLUGIN_DATA_DIR
REDCONVERT_PLUGIN_TEMP_DIR
REDCONVERT_ALLOWED_HOSTS
REDCONVERT_RUNTIME_MODE
```

Paths exposed to plugins:

```text
pluginRoot       read-only plugin install root
pluginDataDir    persistent plugin data directory
pluginTempDir    temporary job/cache directory
hostImportDir    host-issued directory for output files that may be imported
```

Plugins should not receive raw workspace root by default.

## 10. Action Protocol

Action is the common structured entry used by AI, command palette, UI slots, workflow steps, and future automations.

`actions.json`:

```json
{
  "actions": [
    {
      "id": "youtube.importFromUrl",
      "title": "Import YouTube URL",
      "description": "Import metadata, subtitles, audio, or video from a YouTube URL.",
      "inputSchema": {
        "type": "object",
        "required": ["url"],
        "properties": {
          "url": { "type": "string" },
          "mode": {
            "type": "string",
            "enum": ["metadata", "subtitles", "audio", "video"]
          }
        }
      },
      "dispatch": {
        "type": "mediaJob",
        "job": "youtube.import"
      },
      "requiresApproval": true,
      "permissions": [
        "media.import",
        "network.request.scoped"
      ]
    }
  ]
}
```

Dispatch types:

```text
mcpTool
mediaJob
hostAction
workflow
connectorSync
```

Action execution flow:

```text
resolve action
-> validate input schema
-> check plugin enabled
-> check permissions and scope
-> request approval if required
-> dispatch through runtime adapter
-> emit structured progress/events
-> return structured result
```

Do not allow actions to write hidden state unless the action schema declares the side effect and the permission check passes.

## 11. Media Job Protocol

`media.json` should become executable, not just a manifest path.

`media.json`:

```json
{
  "jobs": [
    {
      "id": "youtube.import",
      "kind": "importer",
      "title": "Import YouTube Video",
      "inputSchema": {
        "type": "object",
        "required": ["url", "mode"],
        "properties": {
          "url": { "type": "string" },
          "mode": {
            "type": "string",
            "enum": ["metadata", "subtitles", "audio", "video"]
          }
        }
      },
      "executor": {
        "type": "mcpTool",
        "tool": "youtube.download"
      },
      "outputs": [
        "metadata",
        "subtitleFile",
        "audioAsset",
        "videoAsset",
        "knowledgeSource"
      ],
      "concurrency": {
        "maxRunning": 1
      },
      "timeoutMs": 1800000,
      "permissions": [
        "media.import",
        "media.write",
        "network.request.scoped"
      ]
    }
  ]
}
```

Media job kinds:

```text
importer
transcriber
processor
generator
exporter
analyzer
```

Media job execution flow:

```text
submit plugin media job
-> validate input schema
-> check permissions
-> create job record
-> call executor adapter
-> stream progress
-> validate output paths are inside allowed plugin/temp/import dirs
-> host imports media/knowledge outputs
-> persist job artifacts
-> emit completion/failure
```

Host-owned import actions required:

```text
media.importPaths
knowledge.importPluginArtifact
```

These should accept only host-issued or plugin-scoped paths.

## 12. MCP Plugin Design

MCP remains the main protocol for external tools.

`mcp.json`:

```json
{
  "mcpServers": {
    "youtube": {
      "transport": "stdio",
      "command": "node",
      "args": ["./server/index.js"],
      "env": {},
      "oauth": {
        "redbox": {
          "approvalMode": "destructive",
          "toolTimeoutMs": 600000,
          "supportsParallelToolCalls": false,
          "disabledTools": []
        }
      }
    }
  }
}
```

Current MCP strengths to preserve:

- Plugin server namespacing.
- Tool inventory and fingerprint.
- Direct/deferred exposure.
- `tool_search` support.
- Per-tool allow/deny.
- Approval mode.
- Timeout.
- Begin/end runtime events.
- Transcript/checkpoint markers.

Needed v2 additions:

- Runtime env injection with plugin dirs and allowed hosts.
- Result sanitizer for plugin MCP outputs.
- Path output validation before host import.
- Explicit `external.process` high-risk permission when MCP server invokes local binaries.
- Plugin diagnostics that show server startup, tools, policy, recent failures, and effective environment metadata.

## 13. Data Connector Protocol

`connectors.json`:

```json
{
  "connectors": [
    {
      "id": "youtube.channel",
      "kind": "feed",
      "title": "YouTube Channel",
      "inputSchema": {
        "type": "object",
        "required": ["channelUrl"],
        "properties": {
          "channelUrl": { "type": "string" },
          "limit": { "type": "number", "default": 20 }
        }
      },
      "sync": {
        "type": "mcpTool",
        "tool": "youtube.fetchChannel"
      },
      "outputs": [
        "knowledgeSource"
      ],
      "permissions": [
        "knowledge.import",
        "network.request.scoped"
      ]
    }
  ]
}
```

Connector kinds:

```text
feed
folder
remoteDocumentStore
mediaSource
publishTarget
```

Connectors should integrate with scheduler later:

```text
manual sync
background sync
sync interval
last cursor/checkpoint
failure backoff
```

## 14. UI Slot Protocol

UI extensions must stay narrow.

Allowed slots:

```text
settingsPanel
importPanel
mediaInspector
manuscriptSidebar
homeWidget
commandPalette
```

`ui.json`:

```json
{
  "slots": [
    {
      "id": "youtube.importPanel",
      "slot": "importPanel",
      "title": "YouTube",
      "entry": "./ui/import/index.html",
      "requiredPermissions": [
        "media.import",
        "network.request.scoped"
      ]
    }
  ]
}
```

UI slot rules:

- Render in sandboxed iframe/webview.
- No direct access to full `window.ipcRenderer`.
- No global CSS injection.
- No main navigation injection.
- No replacement of core pages.
- No arbitrary workspace file access.
- All host interaction goes through `pluginBridge`.

`pluginBridge` should expose only:

```text
pluginBridge.invokeAction(actionId, payload)
pluginBridge.submitMediaJob(jobId, payload)
pluginBridge.readPluginData(query)
pluginBridge.writePluginData(payload)
pluginBridge.requestApproval(payload)
pluginBridge.getContext()
pluginBridge.onEvent(eventName, handler)
```

UI additions should be sparse. Prefer command/action integration before adding panels.

## 15. Template Pack Protocol

Pure data plugins should not need runtime or high-risk permissions.

`templates.json`:

```json
{
  "templates": [
    {
      "id": "subtitle.clean-bold",
      "kind": "subtitleStyle",
      "title": "Clean Bold",
      "path": "./templates/subtitle/clean-bold.json"
    },
    {
      "id": "cover.minimal",
      "kind": "coverTemplate",
      "title": "Minimal Cover",
      "path": "./templates/cover/minimal.json"
    }
  ]
}
```

Template kinds:

```text
coverTemplate
subtitleStyle
motionPreset
richPostTheme
longformLayout
reactElement
```

## 16. Workflow Protocol

Workflows are structured orchestration, not black-box agents.

`workflows.json`:

```json
{
  "workflows": [
    {
      "id": "youtube.toKnowledge",
      "title": "YouTube to Knowledge",
      "inputSchema": {
        "type": "object",
        "required": ["url"],
        "properties": {
          "url": { "type": "string" }
        }
      },
      "steps": [
        {
          "type": "action",
          "action": "youtube.importFromUrl",
          "input": {
            "url": "{{input.url}}",
            "mode": "subtitles"
          }
        },
        {
          "type": "hostAction",
          "action": "knowledge.importPluginArtifact"
        }
      ]
    }
  ]
}
```

Workflow rules:

- Every step must call a registered action, media job, connector, MCP tool, or host action.
- No arbitrary script steps.
- Each step has structured input/output.
- Permissions are unioned before execution.
- High-risk steps require approval before execution starts.

## 17. Provider Extensions

Provider plugins are useful but risky. Schema can be reserved in v2, but market install should wait for v2.1.

Provider kinds:

```text
llm
embedding
asr
tts
image
video
rerank
```

Provider plugin requirements:

- Strict provider contract.
- No API key exfiltration.
- Host-owned secret storage.
- Explicit network domain.
- Per-provider health check.
- Cost/rate-limit metadata.
- Clear model capability declarations.

## 18. Marketplace And Packaging

Package format:

```text
.rbxplugin
```

The file is a zip archive.

Installation requirements:

- No symlink.
- No absolute path.
- No `..`.
- Single plugin root.
- Manifest exists and validates.
- Entry files validate.
- Package hash recorded.
- Install uses staged copy and atomic rename.
- Upgrade records previous permissions.
- Failed install rolls back.

Marketplace registry:

```json
[
  {
    "id": "youtube-import",
    "name": "YouTube Import",
    "author": "RedConvert",
    "description": "Import YouTube media and subtitles.",
    "repo": "RedConvert/youtube-import-plugin",
    "category": "Media",
    "verified": true,
    "riskLevel": "high"
  }
]
```

Marketplace UI must show:

```text
plugin category
verified/community/local status
permissions
network hosts
external process usage
media/knowledge write usage
supported platforms
package size
last updated
min app version
risk level
```

High-risk plugins such as `youtube-import` should show:

```text
Requires network access.
Runs external media tools.
May download large files.
User is responsible for having rights to process imported content.
```

## 19. Performance Strategy

Required:

- First screen reads only plugin index summaries.
- Registry build must not start plugin runtimes.
- MCP servers are lazy-started.
- Tool inventory uses fingerprint cache.
- Media jobs run in background queue.
- Plugin progress events are throttled.
- Large outputs use temp file + atomic move.
- Each plugin has concurrency limits.
- Each tool/job has timeout.
- Disabling plugin disconnects MCP sessions and prevents new jobs.
- Uninstalling plugin cleans registry records and runtime sessions.
- Plugin cache/temp dirs can be cleaned by diagnostics/maintenance command.

Recommended default limits:

```text
plugin MCP startup timeout: 15s
plugin MCP tool timeout: 60s default, max 10min unless job declares longer
media job timeout: job-defined, clamped
progress event throttle: 300-500ms
per-plugin active media jobs: 1 by default
metadata/probe concurrency: 2 by default
```

YouTube plugin defaults:

```text
metadata/subtitles first
do not download full video by default
download concurrency = 1
metadata probe concurrency = 2
progress throttle = 300-500ms
```

## 20. Security Strategy

Execution-time checks are mandatory.

Before action:

```text
plugin enabled
action registered
input schema valid
required capabilities granted
scope allowed
approval satisfied if required
```

Before media job:

```text
plugin enabled
job registered
input schema valid
media.import/process/write permission present
output paths inside plugin/temp/import dirs
host imports outputs instead of plugin mutating store
```

Before MCP tool:

```text
server belongs to enabled plugin
tool allowed by policy
approval mode satisfied
timeout applied
result sanitized
paths validated before host use
```

Before UI bridge call:

```text
slot valid
plugin enabled
bridge method allowed for slot
requested capability present
payload schema valid
```

Network:

- Manifest declares hostnames only.
- Host injects `REDCONVERT_ALLOWED_HOSTS`.
- Official plugin wrappers should enforce host allowlist.
- If OS-level network sandbox is unavailable, marketplace must label this as policy-level enforcement and official plugins must use the wrapper.

File paths:

- Plugin can read plugin root and plugin data dir.
- Plugin can write plugin data/temp dirs.
- Host can issue import dirs for produced files.
- Plugin cannot receive raw workspace root by default.
- Host validates all plugin-produced paths before import.

## 21. YouTube Import Reference Plugin

Recommended package:

```text
youtube-import/
├── .redbox-plugin/
│   └── plugin.json
├── skills/
│   └── youtube-import/
│       └── SKILL.md
├── mcp.json
├── actions.json
├── media.json
├── connectors.json
├── ui.json
├── server/
│   ├── index.js
│   └── package.json
├── bin/
│   └── README.md
├── assets/
│   └── logo.png
└── README.md
```

Use existing libraries/tools:

```text
yt-dlp
ffmpeg
MCP SDK
```

Self-build in RedConvert host:

```text
plugin permission model
plugin registry
media job adapter
host-owned media import
host-owned knowledge import
progress/cancel/retry events
UI slot bridge
marketplace risk display
diagnostics
```

MCP tools:

```text
youtube.probeUrl
youtube.fetchMetadata
youtube.listFormats
youtube.downloadSubtitles
youtube.downloadAudio
youtube.downloadVideo
youtube.cancelJob
```

Host actions/jobs:

```text
youtube.importFromUrl -> mediaJob youtube.import
youtube.import -> mcpTool youtube.download*
media.importPaths -> host media catalog write
knowledge.importPluginArtifact -> host knowledge write
```

Acceptance criteria:

- User installs plugin from market/local package.
- Enable flow shows network, external process, media write, knowledge import permissions.
- Skill appears in skill catalog with plugin namespace.
- MCP server appears with plugin namespace.
- AI can discover tools through direct exposure or `tool_search`.
- User can submit YouTube URL through action/UI.
- Metadata/subtitles can be imported without downloading full video.
- Audio/video download runs as background media job.
- Job progress is visible and throttled.
- Job can be cancelled.
- Produced files are imported by host into media library.
- Subtitle/metadata can be imported by host into knowledge.
- Disabling plugin removes skills/MCP/actions/jobs from registry.
- Uninstalling plugin cleans registry and runtime sessions.

## 22. Migration From Current Plugin System

Because plugins are not formally released, v2 can be breaking. Still provide one-time migration for local/dev plugins:

- Old `skills` maps to `entry.skills`.
- Old `mcpServers` maps to `entry.mcpServers`.
- Old `actions` maps to `entry.actions`.
- Old `media` maps to `entry.mediaJobs`.
- Old `home` maps to `ui.homeWidget` contribution where possible.
- Old plugin index is rewritten into v2 index on first launch after upgrade.
- Long-term support for old schema is not required.

Implementation note:

- Keep manifest loader able to identify schema v1 and convert to in-memory v2.
- Write v2 index only after successful validation.
- Do not silently grant new high-risk permissions during migration.

## 23. Implementation Plan And Atomic Commits

Each commit should do one thing.

1. `plugins: add codex plugin manifest compatibility`
   - Add `CodexPluginManifest` structs.
   - Treat `.codex-plugin/plugin.json` as a first-class manifest.
   - Normalize Codex plugin manifest into internal plugin v2 records.
   - Preserve raw manifest and compatibility diagnostics.

2. `plugins: add v2 manifest schema and validator`
   - Add `plugins/manifest.rs`.
   - Define v2 structs and schema validation.
   - Keep v1-to-v2 in-memory conversion.
   - Keep RedConvert-native fields separate from Codex-native fields.

3. `plugins: add capability registry`
   - Add `plugins/registry.rs`.
   - Build snapshot from enabled plugins.
   - Include registry fingerprint and diagnostics summary.

4. `plugins: migrate installer to v2 package model`
   - Move install/cache/index code into `plugins/installer.rs`.
   - Preserve staged copy + atomic rename.
   - Record package hash and permission grants.
   - Support local zip/package, GitHub release asset, and GitHub source archive.

5. `plugins: register skills and mcp servers through registry`
   - Replace direct plugin scans in skill/MCP commands with registry views.
   - Preserve MCP namespacing and policy metadata.
   - Verify Codex skill-only plugins such as Remotion work without RedConvert-specific fields.

6. `plugins: map codex app connectors`
   - Parse `.app.json` / `apps` contributions.
   - Preserve app metadata in diagnostics.
   - Map only connectors RedConvert explicitly supports.
   - Mark unsupported app connectors as unavailable without failing install.

7. `plugins: add restricted hook compatibility`
   - Parse Codex hooks if present.
   - Only support safe lifecycle hooks with explicit capability and approval.
   - Mark unsupported hooks in diagnostics instead of failing install when possible.

8. `plugins: add action contribution protocol`
   - Add `actions.json` parser.
   - Register plugin actions.
   - Add action execution adapter with schema validation and permission checks.

9. `plugins: add media job contribution protocol`
   - Add `media.json` parser.
   - Register plugin media jobs.
   - Wire media runtime submit path to plugin job adapter.

10. `plugins: add host-owned plugin artifact import`
   - Add safe `media.importPaths` / equivalent host action.
   - Add safe knowledge artifact import.
   - Validate plugin/temp/import paths.

11. `plugins: add permission enforcement`
   - Centralize capability/scope/approval checks.
   - Enforce before action, media job, MCP call, UI bridge call.
   - Add permission upgrade handling.

12. `plugins: add sandboxed ui slot bridge`
   - Add `ui.json` parser.
   - Add fixed slot registry.
   - Add limited `pluginBridge`.
   - Avoid main navigation injection.

13. `plugins: add marketplace risk metadata`
   - Extend market registry item shape.
   - Show risk level, permissions, network hosts, external process status.

14. `plugins: add diagnostics and sync repair`
   - Add plugin diagnostics view/data.
   - Show registry status, MCP startup, tool inventory, permission grants, recent failures.
   - Add sync/repair command.

15. `docs: add plugin v2 authoring guide`
   - Replace or supersede current authoring guide.
   - Include examples for skill, MCP, action, media job, UI slot, template pack.
   - Include a "Codex plugin compatibility" section.

16. `plugin: add remotion codex plugin compatibility test`
   - Install `remotion-dev/codex-plugin` from GitHub source archive.
   - Verify its Remotion skill is visible and invokable.
   - Verify referenced rule files are preserved.

17. `plugin: add youtube import reference plugin`
   - Add local reference plugin package or separate repo plan.
   - Use it as v2 acceptance test.

## 24. Verification Matrix

Manifest and install:

- Invalid path rejected.
- Symlink rejected.
- Unknown capability rejected.
- Unknown UI slot rejected.
- Unsafe network host rejected.
- Update with new high-risk permission requires reauthorization.
- Codex plugin `.codex-plugin/plugin.json` installs without RedConvert manifest.
- GitHub repo source archive install works when no release asset exists.
- Codex plugin relative skill references are preserved.

Registry:

- Enabled plugin contributes expected capabilities.
- Disabled plugin contributes nothing.
- Uninstall removes capabilities.
- Registry fingerprint changes when capabilities change.

MCP:

- Plugin MCP server is namespaced.
- MCP tools appear in inventory.
- Direct/deferred exposure works.
- `tool_search` finds deferred plugin tools.
- Policy deny prevents tool call.
- Approval-required tool pauses and resumes correctly.

Actions:

- Input schema validation rejects invalid payload.
- Action dispatches to media job / MCP tool.
- Missing permission blocks execution.
- Approval-required action prompts before side effect.

Media jobs:

- Job progress emitted.
- Job cancellation works.
- Timeout works.
- Output path outside plugin/temp/import dirs is rejected.
- Host imports media asset correctly.
- Host imports knowledge artifact correctly.

UI slots:

- Slot loads only when plugin enabled.
- UI bridge cannot call unregistered action.
- UI bridge cannot access full IPC.
- Disabling plugin removes slot.

YouTube reference:

- Metadata-only import works.
- Subtitle import works without full video download.
- Audio/video import runs in background.
- Media library contains imported output.
- Knowledge source can be created from subtitle/metadata.

Codex compatibility:

- `remotion-dev/codex-plugin` installs from GitHub repo.
- The Remotion skill appears in skill catalog with plugin namespace.
- Skill invocation loads `SKILL.md` and rule references.
- A Codex skill-only plugin does not require MCP/action/media fields.
- A Codex MCP plugin registers MCP servers through the registry.
- Unsupported Codex surfaces are listed in diagnostics without crashing install.

## 25. Recommended Final Direction

Use **Codex-Compatible Capability Pack Plugin System v2**.

Do not choose:

- Obsidian-style unrestricted JS plugins.
- MCP-only plugins.
- A yt-dlp-specific host exception.

Recommended split:

```text
Codex plugin compatibility is the baseline.
MCP handles external tools.
Action handles unified invocation.
Media Job handles long-running media work.
Skill handles AI behavior and boundaries.
UI Slot handles narrow interaction.
Template Pack handles pure assets.
Workflow handles reusable structured orchestration.
Registry keeps capabilities discoverable and auditable.
Permission Runtime enforces safety.
```

If `youtube-import` can be implemented cleanly on this system, RedConvert can later support:

- Bilibili / Douyin / Xiaohongshu importers.
- Subtitle processors.
- FFmpeg media processors.
- Publishing platform connectors.
- Model provider plugins.
- Cover template packs.
- Motion packs.
- Rich post themes.
- Longform layout packs.
- Automated content workflows.
