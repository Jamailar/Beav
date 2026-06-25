# Beav Chrome 插件

这个目录提供 Beav 的工程化构建源码，用来把外部网页内容采集到 Beav 桌面端知识库和素材库。

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
- native host：Chrome native messaging manifest 指向用户目录里的 launcher，launcher 用绝对 Node 路径执行 `native-host/host.mjs`，再在本机暴露 newline JSON-RPC socket。不要让 GUI Chrome 直接执行 `#!/usr/bin/env node` 的 `.mjs`，否则 Finder 启动的 Chrome 可能因 PATH 找不到 Node 而立刻退出。
- App 内置 MCP：桌面端启动时会自动注册 `Beav Browser Control` MCP server，stdio command 指向 Beav App 自身的隐藏兼容 `--redbox-browser-control-mcp` 模式，不要求用户手动导入 MCP 配置。
- App AI 首选入口：桌面端通过 `Operate(resource="browser", operation="control", input={...})` 暴露 Codex-style browser facade；`open/goto/back/forward/getTab/domSnapshot/queryElements/count/allTextContents/waitForSelector/waitForURL/click/type/press/scroll/screenshot/finalizeTabs` 等 operation 在这一层归一化，MCP / native host 是后端适配层，不作为普通 agent 浏览器任务的直接调用面。
- Agent-side JS client：`scripts/browser-client.mjs` 提供 Codex 同款 `setupBrowserRuntime({ globals }) -> agent.browsers.get("extension")` 入口，用对象方法包装 `browser.user.openTabs()`、`browser.tabs.new()`、`tab.playwright.locator()`、`browser.tabs.finalize()` 等能力；底层仍走 Beav native-host socket / MCP 工具。
- 开发 MCP server：`mcp-server.mjs` 保留给插件目录独立调试，负责把 `tools/list` / `tools/call` 转发到 native-host socket。

安装 native host：

```bash
cd /Users/Jam/LocalDev/GitHub/RedConvert/Plugin
pnpm install:native-host -- --extension-id <chrome-extension-id> --node /absolute/path/to/node
```

不传 `--extension-id` 时，安装器会尝试从 Chrome / Edge / Brave 等 profile 里发现已加载的 Beav unpacked extension。`--node` 默认使用当前 Node；面向真实 Google Chrome 时建议传绝对 Node 22 路径，避免 GUI Chrome 的 PATH 与终端不同。

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
pnpm diagnose:browser-control -- --no-fail
pnpm agent:call -- --method host.getInfo
pnpm agent:call -- --method tools/list
```

验收边界：

- “打开网页读取内容”不是浏览器控制验收；必须看到 Beav MCP / native host socket 经真实 Chrome 扩展返回 `tools/list`、`tabs.list`、`tab.info`、DOM 查询和至少一个交互动作。
- `pnpm smoke:browser-control` 使用临时 profile / Chromium 做回归，不代表用户真实 Chrome 可用。
- 真实 Chrome 验收必须使用已安装的 Beav 扩展、真实 Chrome native messaging manifest、真实 socket，以及真实标签页或受控测试标签页。
- 被 `tab.claim` / `tab.create` 纳入 active browser session 的页面必须显示 `Beav 控制中` 页面内标签；释放、finalize 或 turn 结束后自动移除。
- 不要为 smoke 或调试授权 macOS login keychain / Chrome Safe Storage；如果弹出此类提示，应拒绝并改用隔离 profile 或 launcher/PATH 修复。

## 开发命令

```bash
pnpm build
pnpm verify
pnpm check
pnpm install:native-host -- --extension-id <chrome-extension-id>
pnpm diagnose:browser-control
pnpm smoke:browser-control
pnpm mcp:server
pnpm package
```

- `pnpm build`：把 `src` 里的 manifest、HTML、CSS、图片和脚本构建到 `dist/extension`。
- `pnpm verify`：检查 manifest、HTML 引用、动态注入脚本和关键 content script 合同。
- `scripts/browser-client.mjs`：供 agent / 调试脚本按 Codex Browser Use 对象 API 使用 Beav browser-control；配套文档在 [Plugin/docs/browser-runtime.md](/Users/Jam/LocalDev/GitHub/RedConvert/Plugin/docs/browser-runtime.md)。
- `pnpm install:native-host`：安装 Chrome native messaging host manifest。
- `pnpm diagnose:browser-control`：检查 native host manifest、launcher、Beav endpoint socket 和 extension forwarding 状态；需要只取报告时加 `-- --no-fail`。
- `pnpm smoke:browser-control`：用临时 Chrome profile 加载构建后的扩展，临时安装 native host manifest，验证 native socket、tools/list、tab 创建和 DOM 读取；结束后恢复 manifest。
- `pnpm mcp:server`：启动开发态 Beav browser-control stdio MCP server；正式 App 使用内置 Rust MCP 入口。
- `pnpm package`：先构建，再生成 `dist/Beav-<version>.zip`。

## 使用前提

- Beav 桌面端必须已经启动。
- 当前桌面端会在本地开启 `http://127.0.0.1:31937/api/knowledge` 供插件写入知识库。

## 使用方式

- 点击浏览器扩展图标会打开 Beav 侧边栏，不再使用 popup。
- 可在扩展详情页点击“扩展程序选项”，或在侧边栏顶部点击设置按钮，打开插件设置页。
- 侧边栏展示当前页面识别、统一任务队列和批量采集入口；详情页采集、下载、导出等轻操作仍通过网页内 DOM 注入按钮触发。
- 在小红书详情页可使用笔记操作区注入按钮：Beav 保存、下载压缩包、下载素材、采集评论。
- 在已注入页面右侧可使用 Beav 浮动采集面板；小红书笔记页、YouTube、抖音、公众号和普通网页会显示不同动作。
- 小红书博主页不再显示右侧浮动采集面板；可使用浏览器侧边栏或资料区注入按钮采集主页笔记，采集会优先读取 `user_posted`，失败时滚动主页收集已加载出来的笔记链接。
- 在小红书信息流、搜索页、博主页可点击卡片右上角“采集”按钮保存单条笔记。
- 批量采集默认串行执行；设置页可调整每条笔记之间的随机采集间隔、博主主页默认条数、关键词默认条数和链接批量上限。
- 从多个页面、多个侧边栏或 DOM 注入按钮触发的小红书任务会进入同一个后台队列，避免并发采集互相冲突。
- 博主笔记、链接批量、当前页批量和关键词采集支持在任务队列中暂停、继续或停止；短任务只显示停止。
- 在 YouTube 视频页打开插件，点击“保存 YouTube 视频”
- 在任意网页中选中文字，右键点击“保存选中文字到 Beav”
- 在任意网页使用右侧浮动采集面板保存当前页面链接
- 检测到新版本后，点击“打开更新源”会打开 Beav 下载源，下载插件压缩包后重新加载扩展即可完成更新

## 备注

- 插件负责采集、下载、导出、提交结构化数据，以及为桌面端 AI 暴露浏览器控制 MCP 工具；AI 编排和业务决策仍在桌面端完成。
- `captureRuntime.js` 是平台无关的页面采集底座；平台逻辑应只提供根节点、列表项、字段解析和分页策略，不要把滚动等待、DOM 稳定判断、验证页识别重复写进各个平台 extractor。采集 checkpoint 存在 `redboxCaptureCheckpoints`，用于排查页面刷新、断网或站点限流导致的中断。
- 知识整理、漫步、RedClaw 创作仍在桌面端完成。
- 自动更新检查会在插件安装、浏览器启动和后台定时任务中执行；更新源固定为 `https://redbox.ziz.hk/api/updates/plugin`。
