---
doc_type: guide
execution_status: in_progress
last_updated: 2026-06-16
---

# Thrive / Codex 插件作者指南

本文说明 RedBox desktop 当前插件协议。Host 现在优先兼容 Codex 插件目录约定，可直接安装使用 `.codex-plugin/plugin.json` 的插件，同时保留早期 Thrive / RedBox 插件路径。

## 1. 插件结构

插件可以是一个目录，也可以打包成 `.thriveplugin` / `.rbxplugin` / `.zip`。

```text
my-plugin/
├── .codex-plugin/
│   └── plugin.json
├── skills/
│   └── writer/
│       └── SKILL.md
├── .mcp.json
├── .app.json
├── hooks/
│   └── hooks.json
└── assets/
    └── logo.png
```

Manifest 发现顺序：

```text
.codex-plugin/plugin.json
.claude-plugin/plugin.json
.redbox-plugin/plugin.json
.thrive-plugin/plugin.json
plugin.json
```

新插件推荐统一使用 `.codex-plugin/plugin.json`。`.redbox-plugin`、`.thrive-plugin` 和根 `plugin.json` 只作为旧包兼容入口。

也可以直接安装 Codex marketplace 目录：

```text
marketplace-root/
├── .agents/
│   └── plugins/
│       └── marketplace.json
└── plugins/
    └── my-plugin/
        └── .codex-plugin/
            └── plugin.json
```

RedBox 会读取 `.agents/plugins/marketplace.json` 或 `.claude-plugin/marketplace.json`。当 marketplace 里只有一个 local plugin 时，`plugins:install { path }` 会直接安装；当有多个 local plugin 时，需要传 `pluginName`、`pluginId` 或 `id` 指定其中一个。local source 路径必须按 Codex 规则写成 `./...`，且不能离开 marketplace root。

Agent 侧也提供 Codex 对等的插件发现 / 安装入口：

- `plugins.list`：列出已安装且 RedBox 可同步的 Codex-compatible 插件。
- `plugins.connectors`：列出已启用插件声明的 Codex `AppInfo` 风格 connectors。
- `plugins.discoverLocal`：检查本地插件目录、父目录或 Codex marketplace root，返回可安装 local plugin 候选。
- `plugins.marketplace`：读取 GitHub-hosted marketplace registry。
- `plugins.codexMarketplace`：读取本机 Codex remote catalog cache 和插件缓存，可传 `path` / `codexRoot` 指向 Codex home、cache root、marketplace root 或单个插件目录。
- `plugins.install`：从本地插件目录、插件压缩包或 Codex marketplace root 安装插件。
- `plugins.installCodex`：从 Codex 插件缓存条目的 `sourceRoot` 安装，或传 `remotePluginId` 复用 Codex ChatGPT auth 下载远程 bundle 安装；安装后 marketplace 标记为 `codex`。
- `plugins.requestInstall`：生成 Codex 风格的安装建议元数据，用于模型在推荐插件或 connector 前发起确认，不会直接安装。

Codex marketplace root 里包含多个 local plugin 时，推荐先调用 `plugins.discoverLocal { "path": "/path/to/marketplace" }` 获取候选，再调用 `plugins.install { "path": "/path/to/marketplace", "pluginName": "..." }` 精确安装。

## 2. Manifest

```json
{
  "name": "xhs-writer",
  "version": "1.0.0",
  "description": "小红书内容创作和改稿插件",
  "keywords": ["xhs", "writing"],
  "skills": "./skills",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "hooks": "./hooks.json",
  "actions": "./actions.json",
  "media": "./media.json",
  "permissions": {
    "capabilities": [
      "ai.skill",
      "mcp.server",
      "ui.home",
      "knowledge.read",
      "manuscripts.read",
      "media.read",
      "manuscripts.write.current"
    ],
    "approvalRequired": [
      "manuscripts.write.current"
    ],
    "network": ["api.example.com"]
  },
  "interface": {
    "displayName": "小红书写作助手",
    "shortDescription": "选题、改稿、标题和笔记结构优化",
    "developerName": "RedBox",
    "category": "Writing",
    "websiteURL": "https://example.com",
    "privacyPolicyURL": "https://example.com/privacy",
    "termsOfServiceURL": "https://example.com/terms",
    "defaultPrompt": [
      "帮我把当前稿件改成小红书风格"
    ],
    "brandColor": "#3B82F6",
    "composerIcon": "./assets/logo.png",
    "logo": "./assets/logo.png"
  },
  "home": {
    "widgets": [
      {
        "id": "recent-drafts",
        "title": "最近稿件",
        "kind": "list",
        "source": "manuscripts.recent",
        "limit": 4,
        "tone": "sky",
        "order": 10
      }
    ],
    "quickActions": [
      {
        "id": "rewrite-latest",
        "label": "改写最近稿件",
        "prompt": "帮我检查最近稿件，并给出可以直接执行的改写建议。",
        "target": "redclaw",
        "order": 10
      }
    ],
    "sidebarSections": [
      {
        "id": "knowledge-count",
        "title": "知识库素材",
        "kind": "metric",
        "source": "knowledge.count",
        "tone": "emerald"
      }
    ]
  }
}
```

## 3. 校验规则

- `name` 只能使用 ASCII 字母、数字、`-`、`_`。
- `version` 只能使用 ASCII 字母、数字、`.`、`+`、`-`、`_`。
- manifest 内路径必须以 `./` 开头。
- manifest 内路径不能包含 `..`。
- Codex 可选资源路径和 interface asset 路径按 Codex 行为 best-effort 解析；无效路径会被忽略，不会允许越过插件根目录，也不会阻止安装。
- Codex interface 字段支持 `websiteURL`、`privacyPolicyURL`、`termsOfServiceURL`、`brandColor`、`composerIcon`、`logo`、`screenshots`、`defaultPrompt`。
- `hooks` 支持 Codex 的 path、path array、inline object、inline object array 形状；manifest 未声明 `hooks` 时按 Codex 默认读取 `hooks/hooks.json`。
- `apps` 支持 Codex `.app.json` 声明读取，插件摘要会暴露 connector ids、声明名和 category；真正 connector tool runtime 依赖后续专用 connector backend。
- UI slot、capability 必须是 Thrive 已知枚举。
- `network` 只能声明 hostname，不能包含协议、路径或 `*`。
- 压缩包不能包含不安全路径。
- symlink 当前默认拒绝。

## 4. Skill 插件

插件可以在 `skills` 目录下贡献一个或多个技能：

```text
skills/
└── writer/
    └── SKILL.md
```

安装并启用插件后，Thrive 会把技能同步到现有 skill catalog。为避免和宿主技能冲突，插件技能会自动加命名空间：

```text
<plugin-name>:<skill-name>
```

例如 `xhs-writer` 插件里的 `writer` 技能会变成：

```text
xhs-writer:writer
```

`SKILL.md` 示例：

```md
---
description: 将当前稿件改成小红书风格，保留事实和核心观点。
---

使用当前绑定稿件作为唯一修改目标。
不要猜测其他文件。
需要写回时使用当前稿件写入能力。
```

## 5. MCP 插件

插件可以贡献 Codex 风格 `.mcp.json`。RedBox 也保留旧 `mcp.json` fallback。

```json
{
  "mcpServers": {
    "yt-dlp": {
      "type": "stdio",
      "command": "node",
      "args": ["./server.js"],
      "cwd": "./",
      "env": {
        "PLUGIN_MODE": "thrive"
      },
      "env_vars": ["PLUGIN_TOKEN"],
      "enabled_tools": ["download"],
      "tool_timeout_sec": 60
    }
  }
}
```

安装并启用后，MCP server 会进入现有 MCP 列表。server 名称会自动加插件命名空间：

```text
<plugin-name>__<server-name>
```

例如：

```text
xhs-writer__yt-dlp
```

Thrive 会在 MCP server `oauth.redbox` 里写入：

```json
{
  "pluginId": "xhs-writer@local",
  "pluginName": "xhs-writer"
}
```

禁用或卸载插件时，这些派生 MCP server 会自动从 store 中移除。

RedBox MCP loader 支持 Codex 的两种文件形状：

```json
{ "mcpServers": { "server": { "command": "node" } } }
```

```json
{ "server": { "command": "node" } }
```

支持的 Codex 字段包括 `type` / `transport`、`command`、`args`、`cwd`、`env`、`env_vars`、`url`、`oauth.clientId`、`bearer_token_env_var`、`http_headers`、`env_http_headers`、`required`、`startup_timeout_sec`、`tool_timeout_sec`、`supports_parallel_tool_calls`、`default_tools_approval_mode`、`enabled_tools`、`disabled_tools` 和 `tools`。相对 `cwd` 必须留在插件根目录内；stdio server 默认以插件根目录为 `cwd`。

## 6. Codex Hooks

插件可以贡献 Codex 风格 hook 声明。推荐使用默认路径：

```text
hooks/hooks.json
```

也可以在 manifest 里显式声明：

```json
{
  "hooks": "./hooks/hooks.json"
}
```

支持的文件结构：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash|shell",
        "hooks": [
          {
            "type": "command",
            "command": "node ./hooks/pre-tool.js",
            "commandWindows": "node .\\hooks\\pre-tool.js",
            "timeout": 30,
            "async": false,
            "statusMessage": "Checking tool call"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          { "type": "prompt" },
          { "type": "agent" }
        ]
      }
    ]
  }
}
```

安装并启用后，RedBox 会把每个 handler 同步成 runtime hook record，保留 `event`、`matcher`、`type`、`command`、`commandWindows`、`timeout`、`async`、`statusMessage`、`pluginId`、`pluginRoot`、`pluginDataRoot`、`sourcePath` 和 `sourceRelativePath`。禁用或卸载插件时，这些派生 hook 会自动移除。

当前执行语义：

- `PreToolUse` / `PostToolUse` 的 `type: "command"` 且 `async: false` hooks 会在工具调用前后执行。
- hook command 通过 stdin 接收 Codex 风格 JSON：`session_id`、`turn_id`、`cwd`、`hook_event_name`、`model`、`permission_mode`、`tool_name`、`tool_input`、`tool_use_id`，`PostToolUse` 额外包含 `tool_response`。
- command 环境变量包含 `PLUGIN_ROOT`、`PLUGIN_DATA`、`CLAUDE_PLUGIN_ROOT`、`CLAUDE_PLUGIN_DATA`，并支持在 command 字符串里替换 `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`。
- `PreToolUse` 支持 `decision: "block"` / exit code `2` 阻断工具调用，也支持 `hookSpecificOutput.updatedInput` 改写工具输入。
- `PostToolUse` 会执行并记录 hook 反馈；当前不会把 `continue: false` 映射成 host turn 级停止。
- `type: "prompt"` 和 `type: "agent"` 会按 Codex 配置类型保留声明，但当前 Codex hooks runtime 的实际执行路径是 command handler。

## 7. Codex App Connectors

插件可以声明 Codex / ChatGPT connector 依赖：

```json
{
  "apps": {
    "calendar": {
      "id": "connector_calendar",
      "category": "productivity"
    },
    "drive": {
      "id": "connector_drive"
    }
  }
}
```

RedBox 会读取 `.app.json` 或 manifest `apps` 指定的路径，并在插件摘要里暴露：

- `appConnectorIds`：去重后的 connector id 列表。
- `appConnectors`：完整声明，包含 manifest key、connector id 和 category。

也可以通过 `plugins:connectors` 获取 Codex `AppInfo` 风格的 connector 列表。该列表会合并所有已启用插件声明的 connector，包含 `id`、`name`、`installUrl`、`isAccessible`、`isEnabled` 和 `pluginDisplayNames`。

Agent runtime 可通过 `plugins.requestInstall` 对 connector id 发起 Codex 风格安装建议；返回值会包含 `toolType: "connector"`、`toolId`、`toolName`、`installUrl`、`suggestReason` 和 `meta.codexApprovalKind: "tool_suggestion"`。

当前边界：RedBox 已完整保留 Codex app connector 声明元数据，但 ChatGPT connector 授权、目录缓存和远程 invoke runtime 是 Codex backend 能力，当前桌面端还没有等价 backend。

## 8. 插件市场发布

Thrive 的默认插件市场读取：

```text
https://raw.githubusercontent.com/ThrivingOS/Thrive-release/main/community-plugins.json
```

注册文件格式和 Obsidian 社区插件保持同类结构，只登记仓库位置：

```json
[
  {
    "id": "xhs-writer",
    "name": "小红书写作助手",
    "author": "RedBox",
    "description": "选题、改稿、标题和笔记结构优化",
    "repo": "ThrivingOS/thrive-xhs-writer"
  }
]
```

用户在设置页加载插件市场后，Thrive 会按以下顺序读取插件仓库：

1. 从 `main` / `master` 分支查找 `.redbox-plugin/plugin.json`、`.thrive-plugin/plugin.json`、`.codex-plugin/plugin.json`、`plugin.json`。
2. 读取 manifest 的 `version`。
3. 查找 GitHub Release：先查同名 tag，再查 `v<version>`，最后查 latest release。
4. 在 release assets 中选择 `.thriveplugin`、`.rbxplugin` 或 `.zip`。
5. 下载资产、解压/校验 manifest、安装到 `thrive-plugins/cache/community/<plugin-name>/<version>`。

因此，一个可从市场安装的插件仓库必须提供：

- 一个有效 manifest。
- 一个 GitHub Release。
- 一个 release asset，扩展名为 `.thriveplugin`、`.rbxplugin` 或 `.zip`。

市场只登记仓库，不登记 checksum。安全边界由 GitHub 仓库审核、manifest 校验、capability 声明、启停开关和后续权限确认共同承担。

设置页插件市场还提供 `Codex 插件` tab。该 tab 读取本机 Codex 市场缓存：

- `$CODEX_HOME/cache/remote_plugin_catalog`
- `$CODEX_HOME/plugins/cache`
- `~/.codex/cache/remote_plugin_catalog`
- `~/.codex/plugins/cache`

RedBox 会读取 Codex app-server 写入的 remote catalog cache，并递归扫描已 materialized 的 `.codex-plugin/plugin.json`。已有本地插件包的条目直接安装；remote catalog 条目会读取 Codex `auth.json` / `config.toml`，请求 Codex remote detail 的 `bundle_download_url`，下载 HTTPS `.tar.gz` bundle 后安装。安装时复用本地插件安装流程，但 marketplace 标记为 `codex`，安装目录为 `thrive-plugins/cache/codex/<plugin-name>/<version>`。

## 9. 数据读取

插件不能直接读取 Thrive 的内部 store 或用户工作区。需要通过 `plugins:read-data` 受控读取，host 会先检查插件是否已安装、已启用、并具备对应 capability。

当前支持的数据源：

- `knowledge.count` / `knowledge.recent` / `knowledge.items`：需要 `knowledge.read`。
- `manuscripts.count` / `manuscripts.recent` / `manuscripts.tree`：需要 `manuscripts.read`。
- `media.count` / `media.recent` / `media.assets`：需要 `media.read`。
- `subjects.count` / `subjects.recent` / `subjects.list`：需要 `subjects.read` 或 `assets.read`。

Renderer 调用示例：

```ts
await window.ipcRenderer.plugins.readData({
  pluginId: 'xhs-writer@local',
  source: 'manuscripts.recent',
  limit: 4
});
```

读取结果始终是 JSON，不返回任意文件句柄。后续如果开放全文读取、二进制读取或导出，需要单独 capability 和用户确认。

## 10. 主页扩展

主页扩展使用 manifest 的 `home` 字段声明，不执行第三方前端代码。插件必须声明 `ui.home` capability。

当前支持：

- `home.widgets`：主页主区域卡片。
- `home.sidebarSections`：主页右侧栏卡片。
- `home.quickActions`：AI 建议区里的快捷动作。

Widget 类型：

- `metric`：展示 `*.count` 数据源。
- `list`：展示 `*.recent` / `*.items` / `*.list` 数据源。
- `prompt`：点击后把 `prompt` 送入 RedClaw 草稿。
- `action`：点击后按受控 target 跳转或发起草稿。

受控 target：

- `redclaw`
- `coverStudio`
- `generationStudio`，可配 `mode: "image" | "video"`
- `manuscripts`

这套设计让主页足够灵活，但插件无法接管整个 React 页面，也无法注入任意 JS。需要更复杂交互时，再进入 sandbox iframe UI slot。

## 11. Actions 和 Media

`actions.json` 和 `media.json` 当前已被安装器校验和展示路径，但第一版还没有执行协议。后续实现时必须进入现有 canonical action / media job，而不是直接运行插件脚本。

约束：

- action 必须 schema-first。
- 高风险 action 必须走用户确认。
- media 能力只能创建 job，不能直接改 timeline store。
- 下载类插件应该输出 `media.import` artifact。

## 12. 安装方式

在设置页的“工具 -> Thrive 插件”中输入插件目录或 `.rbxplugin` 路径，然后点击安装。

安装后插件会进入：

```text
Application Support/RedBox/thrive-plugins/cache/local/<plugin>/<version>/
```

插件数据目录：

```text
Application Support/RedBox/thrive-plugins/data/<plugin-id>/
```

## 13. 当前边界

当前已完成：

- 本地安装。
- 启用 / 停用。
- 卸载。
- manifest 校验。
- Codex marketplace local source 安装。
- skill 同步。
- MCP server 同步。
- Codex hook 声明同步。
- Codex `PreToolUse` / `PostToolUse` command hook 执行。
- Codex PostToolUse `continue: false` turn-stop 映射。
- Codex app connector id 读取。
- 设置页 Codex 插件市场 tab 读取本机 Codex remote catalog cache / 插件缓存，并支持本地 cache 安装和 authenticated remote bundle 安装。
- 插件数据目录。
- 受控数据读取。
- 主页 widgets / quick actions / sidebar sections。

尚未完成：

- Codex connector tool runtime。
- sandbox iframe UI slot 执行。
- actions 执行。
- media processor/job 执行。
- 插件签名。
- 插件权限变更重新授权。
