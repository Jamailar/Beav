# `manuscript_package.rs`

稿件工程模块。

当前已经固定为混合协议：

- `*.redpost` 图文工程：正文走方案一，分页走宿主自动重排
- `*.redarticle` 长文工程：正文走方案二，AI 直接生成最终 HTML

## 工程文件结构

### 图文工程 `*.redpost`

- `manifest.json`
- `content.md`
- `content-map.json`
- `richpost-page-plan.json`
- `manifest.json` 内的 `richpostThemeId`
- `layout.html`
- `pages/page-001.html`
- `pages/page-002.html`
- `cover.json`
- `images.json`
- `assets.json`

说明：

- `layout.html` 不再是单页长文模板，而是多页预览壳文件
- `pages/` 下每个 HTML 都是一张独立的 3:4 图文页
- `layout.template.html` 如果存在，只视为旧链路兼容资产，不是图文主链路必需文件

### 长文工程 `*.redarticle`

- `manifest.json`
- `content.md`
- `manifest.json` 内的 `longformLayoutPresetId`
- `layout.html`
- `wechat.html`
- `cover.json`
- `images.json`
- `assets.json`

## 正式链路

### 图文工程 `*.redpost`

1. Markdown 是唯一正文源。
2. 保存正文时，宿主重建 `content-map.json`。
3. 保存正文时，宿主总是按当前 Markdown 全量重排 `richpost-page-plan.json`。
4. 连续三个空行会被解释为强制分页，优先切开页面段落。
5. AI 点击生成时，只输出一次性的分页规划 JSON，不输出最终 HTML；后续正文再编辑，仍会被自动重排覆盖。
6. 宿主根据当前分页方案渲染每个 `pages/page-xxx.html`。
7. 宿主再生成一个 `layout.html` 作为多页预览壳，iframe 读取每一页。
8. 图文主题通过 `manifest.richpostThemeId` 控制，只改样式层，不改正文层。

### 长文工程 `*.redarticle`

1. Markdown 仍然是正文源。
2. 长文母版通过 `manifest.longformLayoutPresetId` 控制。
3. `layout.html` / `wechat.html` 由 AI 直接读取整份 Markdown 后全量生成。
4. 保存正文时不自动重排 HTML，只有显式点击生成按钮或切换长文母版时才会更新。

## 模块职责

### 宿主

- `src-tauri/src/commands/manuscripts.rs`
  负责正文解析、分页方案生成、页面 HTML 渲染、最终文件写回
- `src-tauri/src/manuscript_package.rs`
  负责工程状态读取，把分页方案和每页 HTML 资产暴露给前端
- `src-tauri/src/helpers.rs`
  负责 `richpost-page-plan.json`、`pages/` 等路径约定

### AI

- `prompts/library/templates/richpost_page_planner.txt`
  负责图文分页规划，只输出 JSON page plan
- `builtin-skills/richpost-layout-designer/SKILL.md`
  负责稿件页 `图文排版` 模式下的专用排版约束，限制 AI 只改 richpost 的样式层和分页层，不改正文层
- `prompts/library/templates/package_html_document_renderer.txt`
  负责长文 `layout.html` / `wechat.html` 全量生成
- `builtin-skills/longform-layout-designer/SKILL.md`
  负责稿件页 `长文排版` 模式下的专用排版约束，限制 AI 只改长文母版和 HTML 样式层，不改正文层

### 前端

- `src/pages/Manuscripts.tsx`
  负责生成按钮、保存前同步、包状态刷新
- `src/components/manuscripts/WritingDraftWorkbench.tsx`
  负责图文多页 iframe 预览和长文 HTML 预览

## 宿主命令

- `manuscripts:generate-richpost-page-plan`
- `manuscripts:render-richpost-pages`
- `manuscripts:set-richpost-theme`
- `manuscripts:set-longform-layout-preset`
- `manuscripts:pick-richpost-export-path`
- `manuscripts:save-richpost-export-archive`
- `manuscripts:save-richpost-export-image`
- `manuscripts:generate-package-html`
- `manuscripts:save-package-html`

兼容保留：

- `manuscripts:generate-package-template`
- `manuscripts:save-package-template`
- `manuscripts:render-package-html`

这些旧模板命令仍可兼容旧资产，但图文主链路已经不依赖它们。

## 触发规则

- 新建图文工程时，默认写入：
  - `content-map.json`
  - `richpost-page-plan.json`
  - `layout.html`
  - `pages/` 下首版分页 HTML
- 图文保存正文时：
  - 自动重建 `content-map.json`
  - 自动按当前 Markdown 全量重排分页方案
  - 自动重写全部 `pages/page-xxx.html`
- 图文绑定封面 / 配图后：
  - 自动重渲染页面和预览壳
- 图文点击“生成分页方案”时：
  - AI 重新输出 `richpost-page-plan.json`
  - 宿主重写全部 `pages/page-xxx.html`
  - 后续再编辑正文时，这份 AI 方案会被自动重排覆盖
- 图文切换预设主题时：
  - 只更新 `manifest.richpostThemeId`
  - 宿主重渲染全部 `pages/page-xxx.html`
  - 正文 `content.md` 和 `content-map.json` 不会被改写
- 稿件页进入 `图文排版` 模式时：
  - 当前文件会话会强制激活 `richpost-layout-designer`
  - AI 必须先按这个 skill 处理 richpost 主题、字体、分页和页面样式任务
- 图文点击“导出”时：
  - 前端逐页加载 `pages/page-xxx.html`
  - 以 1080x1440 的 3:4 固定画布导出 PNG
  - 再把所有 PNG 打进一个 zip 压缩包
  - 导出结果和当前预览使用同一份 HTML
- 长文保存正文时，不自动重排 HTML
- 长文切换母版时：
  - 只更新 `manifest.longformLayoutPresetId`
  - 宿主立即重做当前目标的 `layout.html` 或 `wechat.html`
  - 正文 `content.md` 不会被改写
- 稿件页进入 `长文排版` 模式时：
  - 当前文件会话会强制激活 `longform-layout-designer`
  - AI 必须先按这个 skill 处理长文母版、分栏、字体和 HTML 样式任务
- 长文点击“生成排版 / 生成公众号”时，AI 直接重写最终 HTML

## 性能策略

- 图文保存时只重建结构化内容映射、默认分页方案和页面文件，不重新请求 AI
- 自动重排只做本地 JSON/HTML 生成，不走浏览器测量和模型调用，成本很低
- 前端预览直接读取真实文件，不在渲染层拼接大段 HTML 字符串
- `layout.html` 只做预览壳，把多页卡片拆到 `pages/` 下独立加载

## 备选说明

长文工程保留方案二，是因为长文阅读页更依赖全文语义和整体版式；图文工程改成自动重排，是因为小红书图文的编辑频率高，正文一改就应立即得到新的稳定分页结果。
