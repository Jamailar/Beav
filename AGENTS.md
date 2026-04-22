# RedBox / RedConvert Agent Guide

面向 AI coding assistants 和开发者的仓库级开发指南。目标不是重复 README，而是提供“如何在这个仓库里安全、准确、低回归地改代码”的执行规则。

## Scope And Priority

- 本文件作用于仓库根目录默认范围。
- 如果进入某个子目录存在更近的 `AGENTS.md`，以更近的文件为准。
- `desktop/` 是当前主桌面端并有自己的 `AGENTS.md`。
- `archive/desktop-electron/` 是归档的旧 Electron 实现；除非任务明确涉及迁移对照或历史问题，否则不要默认改它。

## Environment Baseline

- Node 版本统一按 `>=22 <23` 处理。
- 根目录声明 `pnpm@10`；桌面端和官网子项目都按 `pnpm` 工作流为准。
- 桌面端是主产品，日常改动默认先检查 `desktop/`。
- 打包、签名、远程 Windows 构建都依赖本地/远程环境，不要在未确认前提下随意调整发布脚本。

## Repository Map

### Core product surfaces

- `Plugin/`：Chrome / Edge 扩展，负责从小红书、YouTube、网页把内容送入桌面端。
- `RedBoxweb/`：官网/发布站点，Next.js 站点，包含少量测试。
- `private/scripts/hybrid-release/`：混合发布链路，本地构建 macOS、远程 Linux 构建 Windows、上传 GitHub Release。

### Generated or packaged outputs

- `desktop/dist/`、`desktop/src-tauri/target/`、`desktop/src-tauri/gen/`、`desktop/release/`：构建产物，禁止手改。
- `archive/desktop-electron/dist/`、`archive/desktop-electron/dist-electron/`、`archive/desktop-electron/release/`：旧桌面端构建产物，同样禁止手改。

### Other important files

- `README.md`：对外说明、更新日志入口，发布脚本也会从这里提取 release notes。
- `private/Docs/` 与 `desktop/docs/`：局部设计说明/接口资料，改动相应领域时应同步。

## Architecture Map

### Renderer -> Host path

- 页面入口：`desktop/src/main.tsx` -> `desktop/src/App.tsx` -> `desktop/src/pages/*`
- 宿主桥：renderer 通过 `window.ipcRenderer` 调用 `desktop/src/bridge/ipcRenderer.ts`
- Tauri 宿主入口：`desktop/src-tauri/src/main.rs`
- 业务实现：`desktop/src-tauri/src/commands/*`、`desktop/src-tauri/src/runtime/*`、`desktop/src-tauri/src/persistence/*`、相关 store/service

默认原则：

- renderer 不直接在页面里散落调用 Tauri 原语，优先走 `window.ipcRenderer` 兼容桥。
- 新增能力时，先扩 `src/bridge/ipcRenderer.ts` 的命名 API，再在页面里消费；不要在页面中散落裸 `invoke/send` 字符串。
- `main.rs` 保持“路由/装配层”角色；真正逻辑尽量下沉到 `commands/*`、`runtime/*`、`persistence/*` 或独立 service/store。

### AI runtime path

- 新运行时能力已经扩展到 session/runtime/task/work abstractions：
  - `desktop/src-tauri/src/agent/*`
  - `desktop/src-tauri/src/runtime/*`
  - `desktop/src-tauri/src/skills/*`
  - `desktop/src-tauri/src/tools/*`
  - `desktop/src-tauri/src/mcp/*`
  - `desktop/src-tauri/src/subagents/*`
- 技能、提示词、工具是 AI 编排主边界。做能力分流时优先改这些边界，而不是在用户消息文本上硬写关键词判断。

### Data and content flow

- 插件采集：`Plugin/` -> 本地 HTTP / IPC 接入桌面端 -> 知识库/索引
- 知识库：`knowledge:*` IPC + `documentKnowledgeStore` / 向量索引 / embedding 服务
- 稿件/媒体：`manuscripts:*`、`media:*`、`cover:*` 相关 store 与共享文件格式
- RedClaw：项目、自动化执行、定时任务、长周期任务、创作者画像等能力由 `redclaw:*` 和相关 core/store 管理
- 后台与计划任务：`backgroundCron.ts`、background task / worker / daemon 相关模块

## Build, Run, And Verification

### Root

- 根目录只有最小 Node 元数据，不是完整 monorepo orchestrator。
- 大多数命令都要进入对应子项目执行。


### Browser extension

- `Plugin/` 是直接加载的扩展目录，不是独立打包工程。
- 改动后应在 Chrome / Edge 扩展管理页重新加载验证。
- 扩展依赖桌面端本地接口；如果采集链路失效，优先先查桌面端是否已启动、桥接端口是否还在。

### Suggested verification matrix

- 改 renderer 页面：至少打开对应页面并验证切换、已有数据保留、刷新态。
- 改 bridge / IPC / Tauri command：至少验证一次真实 renderer 调用，不要只看类型通过。
- 改 AI runtime / tool / prompt：至少跑一轮真实对话或任务，检查事件流、工具调用、权限确认和最终摘要。
- 改 `Plugin/`：验证 popup、background、页面注入或右键入口的真实浏览器行为。
- 改 `RedBoxweb/`：运行 `pnpm test` 和一次 `pnpm build`。

## Coding Conventions

- TypeScript / TSX 保持现有文件风格；仓库内存在新旧代码混合，不要顺手重排无关内容。
- 优先单引号、保留分号、遵循现有缩进与命名风格。
- React 页面组件使用 `PascalCase` 文件名，页面级逻辑留在 `desktop/src/pages/`，共用模式再提取。
- Tailwind 优先复用现有 utility pattern，不要无必要引入局部 CSS 体系。
- 新 IPC channel 命名保持现有域分组，例如 `chat:*`、`runtime:*`、`knowledge:*`、`redclaw:*`、`subjects:*`、`media:*`。

## AI System Rules

这是一个 AI 系统。AI 交互、编排与工具链改动，遵守以下优先级：

1. skills、prompts、角色配置定义能力边界和决策原则
2. structured metadata / typed payload / explicit runtime mode 承载路由意图
3. tool/runtime 层负责输入校验、安全边界和执行约束

因此：

- 避免通过用户消息里的硬编码关键词/文本片段判断意图，除非没有更结构化的承载方式。
- 如必须加约束，优先使用 typed state、schema、tool contract、role spec、runtime mode。
- 文本启发式只能是最后手段，而且必须窄、显式、可移除。

## UX State Rule

- 已有用户可见数据，不能因为开始刷新就被阻塞式 loading 页面替换。
- 默认使用 stale-while-revalidate：
  - 先渲染缓存/已有数据
  - 后台刷新
  - 只在局部展示刷新状态
- 全页或全面板 loading 只允许用于真正的首次空状态。
- 刷新失败必须保留最后一次成功数据，并以内联错误提示代替清空页面。
- 登录、会话恢复、workspace bootstrap 也遵守同样规则。
- 常规操作优先图标化；不要给语义已经足够清晰的控件再堆说明文字。

## Store Lock Rule

- 全局状态锁必须保持窄范围、仅内存。
- 不要在持锁期间做文件 I/O、目录扫描、workspace hydration、序列化、索引构建或其他慢操作。
- 固定模式：
  - 持锁读取最小快照
  - 释放锁
  - 在锁外完成文件/工作区操作
  - 重新持锁只应用最终内存变更
- 页面激活、聊天响应后维护、workspace 启动、列表加载都默认遵守此规则。

## Common Change Playbooks

### Add or change a page

- 入口通常在 `desktop/src/App.tsx`。
- 先确认现有页面缓存/挂载策略，不要破坏当前按最近访问保留视图的行为。
- 页面切换期间保留已有状态，避免把切页实现成“每次重新冷启动”。


## Known Pitfalls

- `desktop/src-tauri/src/main.rs` 仍然很大。除纯路由接线外，新增逻辑优先抽到 `commands/*`、`runtime/*` 等子模块。
- `archive/desktop-electron/` 仍保留旧实现与旧文档；除非你明确在处理历史逻辑，不要把它当成当前产品代码入口。
- 插件依赖桌面端本地接入层；插件“坏了”不一定是插件本身，也可能是桌面端服务未起。
- 桌面端仍兼容 `window.ipcRenderer` 与一批旧 channel 名称；改桥接或命令层时先确认兼容面是否仍被页面消费。
- 调度逻辑使用本地时间；涉及 daily/weekly/cron 语义时，不要无视时区与 DST 行为。
- 不要把用户可见页面在刷新时清空成 loading 态。
- 不要在持锁范围内做慢 I/O。

## Documentation Expectations

- 新增或重构重要 IPC/bridge 能力时，更新相应 README / Docs，避免知识只留在 `main.ts` 里。
- 新增重要提示词、技能、运行时模式、工具包时，应在附近补足最小文档，让后续维护者知道入口和职责。
- 如果某次 bug 修复沉淀出新的工程约束，优先把规则加到这里，写得窄、明确、可执行。
- 计划类文档默认放在与功能最接近的 `docs/` 目录；桌面端计划优先放在 `desktop/docs/`。
- 所有“计划 / 方案 / 路线图 / 改造计划”类 Markdown 文档必须使用 frontmatter，且必须包含执行状态字段，至少包括：
  - `doc_type: plan`
  - `execution_status`: `not_started` | `in_progress` | `blocked` | `completed` | `cancelled`
  - `last_updated`: `YYYY-MM-DD`
- 如需更细粒度跟踪，可额外增加 `execution_stage`、`owner`、`target_files`、`success_metrics` 等字段，但 `execution_status` 是强制项。
- 后续新增计划文档时，先更新 frontmatter 中的执行状态，再更新正文，避免出现“文档存在但无法判断执行进度”的情况。


# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
