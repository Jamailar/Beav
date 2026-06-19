# RedBox Chrome 插件

这个目录提供 RedBox Capture 的工程化构建源码，用来把外部网页内容采集到 RedBox 桌面端知识库和素材库。

## 当前支持

- 小红书笔记 / 文章详情页保存
- 小红书详情页操作区 DOM 注入按钮
- 全站右侧固定浮动采集面板
- 小红书信息流卡片 DOM 注入采集按钮
- 小红书博主页 DOM 注入博主采集 / 主页笔记采集按钮
- 小红书页面接口响应缓存，用于复用页面自身加载出来的笔记列表
- 小红书图片 / 视频素材下载
- 小红书评论快照采集
- 小红书博主主页笔记批量采集
- 小红书当前页 / 关键词搜索批量采集
- 小红书批量采集随机间隔控制
- 小红书后台统一任务队列和当前任务状态
- 通用采集运行时：页面内滚动追踪、可见节点判断、数量解析、展开按钮点击、基础验证页检测和采集 checkpoint
- 侧边栏执行日志：展示任务开始、保存成功、部分成功和失败原因
- 小红书采集任务历史和 JSON 导出
- 插件设置页：本地 API、采集间隔、默认采集数量和更新检查配置
- 侧边栏和页面浮动面板平台识别：小红书、抖音、快手、Bilibili、TikTok、Reddit、X、Instagram
- YouTube 视频页 / Shorts 页
- 任意网页链接收藏
- 任意网页选中文字摘录（右键菜单）
- 自动检查插件更新
- AI 浏览器控制：tab/session、DOM snapshot、selector 查询、点击、输入、滚动、截图、CDP、下载状态、页面资产读取
- MCP / native host 控制面：`App AI -> MCP server -> native-host socket -> Chrome extension -> page`

## 加载方式

先构建扩展产物：

```bash
cd /Users/Jam/LocalDev/GitHub/RedConvert/Plugin
pnpm install
pnpm build
pnpm verify
```

1. 打开 Chrome 或 Edge。
2. 进入扩展管理页：
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. 打开“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择当前仓库里的 [Plugin/dist/extension](/Users/Jam/LocalDev/GitHub/RedConvert/Plugin/dist/extension) 目录。

源码在 [src](/Users/Jam/LocalDev/GitHub/RedConvert/Plugin/src) 目录。`dist/extension` 是构建产物，不要手改。

## AI / MCP 控制面

浏览器控制层是叠加能力，不替换现有结构化采集：

- 现有采集：`pageObserver.js`、`xhsBridge.js`、`captureRuntime.js` 保持 content script 常驻，用于小红书、多平台识别、右键保存和网页浮动面板。
- AI 控制：`browserControlContent.js` 只在 AI 调用浏览器工具时动态注入。
- native host：`native-host/host.mjs` 通过 Chrome native messaging 连接扩展，并在本机暴露 newline JSON-RPC socket。
- App 内置 MCP：桌面端启动时会自动注册 `RedBox Browser Control` MCP server，stdio command 指向 RedBox App 自身的隐藏 `--redbox-browser-control-mcp` 模式，不要求用户手动导入 MCP 配置。
- 开发 MCP server：`mcp-server.mjs` 保留给插件目录独立调试，负责把 `tools/list` / `tools/call` 转发到 native-host socket。

安装 native host：

```bash
cd /Users/Jam/LocalDev/GitHub/RedConvert/Plugin
pnpm install:native-host -- --extension-id <chrome-extension-id>
```

App 安装包内置 MCP 配置由桌面端自动写入，不需要用户选择目录或手动配置。独立开发调试时可使用：

```json
{
  "command": "node",
  "args": ["/Users/Jam/LocalDev/GitHub/RedConvert/Plugin/mcp-server.mjs"]
}
```

插件根目录也提供 [Plugin/.mcp.json](/Users/Jam/LocalDev/GitHub/RedConvert/Plugin/.mcp.json)，用于开发态本地发现或外部 MCP 客户端导入 `browser-control` server；正式 App 运行时优先使用内置 MCP。

调试 socket：

```bash
pnpm agent:call -- --method host.getInfo
pnpm agent:call -- --method tools/list
```

## 开发命令

```bash
pnpm build
pnpm verify
pnpm check
pnpm install:native-host -- --extension-id <chrome-extension-id>
pnpm mcp:server
pnpm package
```

- `pnpm build`：把 `src` 里的 manifest、HTML、CSS、图片和脚本构建到 `dist/extension`。
- `pnpm verify`：检查 manifest、HTML 引用、动态注入脚本和关键 content script 合同。
- `pnpm install:native-host`：安装 Chrome native messaging host manifest。
- `pnpm mcp:server`：启动开发态 RedBox browser-control stdio MCP server；正式 App 使用内置 Rust MCP 入口。
- `pnpm package`：先构建，再生成 `dist/RedBox-Capture-<version>.zip`。

## 使用前提

- RedBox 桌面端必须已经启动。
- 当前桌面端会在本地开启 `http://127.0.0.1:31937/api/knowledge` 供插件写入知识库。

## 使用方式

- 点击浏览器扩展图标会打开 RedBox Capture 侧边栏，不再使用 popup。
- 可在扩展详情页点击“扩展程序选项”，或在侧边栏顶部点击设置按钮，打开插件设置页。
- 侧边栏只展示当前页面识别和统一任务队列；采集、下载、导出等操作统一通过网页内 DOM 注入按钮触发。
- 在小红书详情页可使用笔记操作区注入按钮：RedBox 保存、下载压缩包、下载素材、采集评论。
- 在所有已注入页面右侧可使用 RedBox 浮动采集面板；小红书、YouTube、抖音、公众号和普通网页会显示不同动作。
- 在小红书博主页可使用资料区注入按钮：保存博主、采集主页笔记；主页笔记采集会优先读取 `user_posted`，失败时滚动主页收集已加载出来的笔记链接。
- 在小红书信息流、搜索页、博主页可点击卡片右上角“采集”按钮保存单条笔记。
- 批量采集默认串行执行；设置页可调整每条笔记之间的随机采集间隔、博主主页默认条数、关键词默认条数和链接批量上限。
- 从多个页面、多个侧边栏或 DOM 注入按钮触发的小红书任务会进入同一个后台队列，避免并发采集互相冲突。
- 博主笔记、链接批量、当前页批量和关键词采集支持在任务队列中暂停、继续或停止；短任务只显示停止。
- 在 YouTube 视频页打开插件，点击“保存 YouTube 视频”
- 在任意网页中选中文字，右键点击“保存选中文字到 RedBox”
- 在任意网页使用右侧浮动采集面板保存当前页面链接
- 检测到新版本后，点击“打开更新源”会打开 RedBox 下载源，下载插件压缩包后重新加载扩展即可完成更新

## 备注

- 插件负责采集、下载、导出、提交结构化数据，以及为桌面端 AI 暴露浏览器控制 MCP 工具；AI 编排和业务决策仍在桌面端完成。
- `captureRuntime.js` 是平台无关的页面采集底座；平台逻辑应只提供根节点、列表项、字段解析和分页策略，不要把滚动等待、DOM 稳定判断、验证页识别重复写进各个平台 extractor。采集 checkpoint 存在 `redboxCaptureCheckpoints`，用于排查页面刷新、断网或站点限流导致的中断。
- 知识整理、漫步、RedClaw 创作仍在桌面端完成。
- 自动更新检查会在插件安装、浏览器启动和后台定时任务中执行；更新源固定为 `https://redbox.ziz.hk/api/updates/plugin`。
