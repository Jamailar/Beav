---
doc_type: guide
execution_status: in_progress
last_updated: 2026-05-03
---

# Thrive 插件作者指南

本文说明 Thrive 插件的第一版可用协议。当前已支持本地安装、插件市场安装、启用、停用、卸载、manifest 校验、插件 skill 同步、插件 MCP server 同步、受控数据读取和主页扩展。

## 1. 插件结构

插件可以是一个目录，也可以打包成 `.thriveplugin` / `.rbxplugin` / `.zip`。

```text
my-plugin/
├── .redbox-plugin/
│   └── plugin.json
├── skills/
│   └── writer/
│       └── SKILL.md
├── mcp.json
├── actions.json
├── media.json
└── assets/
    └── logo.png
```

当前 host 也兼容：

```text
.thrive-plugin/plugin.json
.codex-plugin/plugin.json
plugin.json
```

推荐新插件统一使用 `.redbox-plugin/plugin.json`。

## 2. Manifest

```json
{
  "name": "xhs-writer",
  "version": "1.0.0",
  "description": "小红书内容创作和改稿插件",
  "skills": "./skills",
  "mcpServers": "./mcp.json",
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
    "defaultPrompt": [
      "帮我把当前稿件改成小红书风格"
    ],
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

插件可以贡献 `mcp.json` 或 `.mcp.json`。

```json
{
  "mcpServers": {
    "yt-dlp": {
      "transport": "stdio",
      "command": "node",
      "args": ["./server.js"],
      "env": {
        "PLUGIN_MODE": "thrive"
      },
      "oauth": {
        "redbox": {
          "approvalMode": "destructive",
          "toolTimeoutMs": 60000
        }
      }
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

## 6. 插件市场发布

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

## 7. Actions 和 Media

## 8. 数据读取

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

## 7. 主页扩展

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

## 8. Actions 和 Media

`actions.json` 和 `media.json` 当前已被安装器校验和展示路径，但第一版还没有执行协议。后续实现时必须进入现有 canonical action / media job，而不是直接运行插件脚本。

约束：

- action 必须 schema-first。
- 高风险 action 必须走用户确认。
- media 能力只能创建 job，不能直接改 timeline store。
- 下载类插件应该输出 `media.import` artifact。

## 9. 安装方式

在设置页的“工具 -> Thrive 插件”中输入插件目录或 `.rbxplugin` 路径，然后点击安装。

安装后插件会进入：

```text
Application Support/RedBox/thrive-plugins/cache/local/<plugin>/<version>/
```

插件数据目录：

```text
Application Support/RedBox/thrive-plugins/data/<plugin-id>/
```

## 10. 当前边界

当前已完成：

- 本地安装。
- 启用 / 停用。
- 卸载。
- manifest 校验。
- skill 同步。
- MCP server 同步。
- 插件数据目录。
- 受控数据读取。
- 主页 widgets / quick actions / sidebar sections。

尚未完成：

- 插件 marketplace。
- sandbox iframe UI slot 执行。
- actions 执行。
- media processor/job 执行。
- 插件签名。
- 插件权限变更重新授权。
