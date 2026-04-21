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
- `layout.tokens.json`
- `../themes/richpost-themes.json`
- `../themes/richpost-theme-assets/<theme-id>/`
- `masters/cover.master.html`
- `masters/body.master.html`
- `masters/ending.master.html`
- `richpost-page-plan.json`
- `manifest.json` 内的 `richpostThemeId`
- `manifest.json` 内的 `richpostTypography`
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
5. 图文样式层拆成三部分：
   - `layout.tokens.json`
   - `masters/*.master.html`
   - `richpost-page-plan.json`
6. 如果走 AI 分页规划，AI 只输出一次性的分页规划 JSON，不输出最终 HTML；后续正文再编辑，仍会被自动重排覆盖。
7. 宿主根据当前母版、token 和分页方案渲染每个 `pages/page-xxx.html`。
8. 宿主再生成一个 `layout.html` 作为多页预览壳，iframe 读取每一页。
9. 图文主题通过 `manifest.richpostThemeId` 控制默认 token 基线，只改样式层，不改正文层。
10. 图文工具栏里的字体大小和行间距调整会写入 `manifest.richpostTypography`，并立即触发整套分页重排；主题提供基础值，用户调整是叠加覆盖值。
11. 稿件画廊里的 `*.redpost` 卡片不会再伪造缩略图；只要正文非空且第一页 HTML 已生成，画廊就直接读取 `pages/` 里的第一页作为真实预览。
12. 工作区级 `themes/richpost-themes.json` 用来保存当前空间共享的自定义图文主题；图文主题抽屉展示的是这份全局主题目录，不再内置预设主题库。
13. `themes/richpost-themes.json` 里的每个主题都包含 `coverFrame / bodyFrame / endingFrame`，它们分别定义首页、内容页、尾页的真实文字区域；主题编辑页左侧的矩形就是这三个字段的可视化编辑层。
14. `themes/richpost-themes.json` 里的每个主题还可以包含 `coverBackgroundPath / bodyBackgroundPath / endingBackgroundPath`；这些路径指向工作区级 `themes/richpost-theme-assets/<theme-id>/` 下的背景图资产，并直接驱动三种母版的背景层。
15. 默认自动分页生成 page plan 时，多页稿件会把第一页映射到 `cover`、中间页映射到 `body`、最后一页映射到 `ending`，这样主题编辑页的三种文字区域会和真实稿件对应。

### 长文工程 `*.redarticle`

1. Markdown 仍然是正文源。
2. 长文母版通过 `manifest.longformLayoutPresetId` 控制。
3. `layout.html` / `wechat.html` 由 AI 直接读取整份 Markdown 后全量生成。
4. 保存正文时不自动重排 HTML，只有显式点击生成按钮或切换长文母版时才会更新。

## 模块职责

### 宿主

- `src-tauri/src/commands/manuscripts.rs`
  负责正文解析、分页方案生成、母版注入、token 合成、页面 HTML 渲染、最终文件写回
- `src-tauri/src/manuscript_package.rs`
  负责工程状态读取，把 token、母版、分页方案和每页 HTML 资产暴露给前端
- `src-tauri/src/helpers.rs`
  负责 `layout.tokens.json`、`masters/`、`richpost-page-plan.json`、`pages/` 等路径约定

### AI

- `prompts/library/templates/richpost_page_planner.txt`
  负责图文分页规划，只输出 JSON page plan
- `builtin-skills/richpost-layout-designer/SKILL.md`
  负责稿件页 `图文排版` 模式下的专用排版约束，限制 AI 只改 richpost 的样式层和分页层，不改正文层
- `builtin-skills/richpost-theme-editor/SKILL.md`
  负责稿件页 `图文主题编辑` 全屏页的专用模板修改约束，要求 AI 优先改 `layout.tokens.json` 与首页/内容页/尾页母版，再决定是否需要调整 page plan
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
- `manuscripts:create-richpost-custom-theme`
- `manuscripts:delete-richpost-custom-theme`
- `manuscripts:get-richpost-theme-previews`
- `manuscripts:preview-richpost-theme-draft`
- `manuscripts:render-richpost-pages`
- `manuscripts:save-richpost-custom-theme`
- `manuscripts:upload-richpost-theme-background`
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
  - `layout.tokens.json`
  - `masters/cover.master.html`
  - `masters/body.master.html`
  - `masters/ending.master.html`
  - `richpost-page-plan.json`
  - `layout.html`
  - `pages/` 下首版分页 HTML
- 图文保存正文时：
  - 自动重建 `content-map.json`
  - 自动按当前 Markdown 全量重排分页方案
  - 自动重写全部 `pages/page-xxx.html`
- 图文绑定封面 / 配图后：
  - 自动重渲染页面和预览壳
- 图文需要补渲染分页时：
  - 前端自动触发一次分页与页面重建
  - 宿主重写 `richpost-page-plan.json` 和全部 `pages/page-xxx.html`
  - 用户不需要手动点“生成分页方案”
- 图文切换预设主题时：
  - 只更新 `manifest.richpostThemeId`
  - 同步重写 `layout.tokens.json`
  - 宿主重渲染全部 `pages/page-xxx.html`
  - 正文 `content.md` 和 `content-map.json` 不会被改写
- 图文调整字体大小 / 行间距时：
  - 只更新 `manifest.richpostTypography`
  - 宿主立即按新的分页输入重排全部 `pages/page-xxx.html`
  - 导出图片和当前预览继续使用同一组排版结果
- 稿件页进入 `图文排版` 模式时：
  - 当前文件会话会强制激活 `richpost-layout-designer`
  - AI 必须先按这个 skill 处理 richpost 主题、字体、分页和页面样式任务
- 图文打开“添加主题”后的全屏主题编辑页时：
  - 宿主会先在当前工作区的 `themes/richpost-themes.json` 中创建一个新的自定义主题条目
  - 当前 AI 会话会绑定这条新主题的 `themeId / label / themes/richpost-themes.json` 文件路径
  - 当前文件会话会切到 `图文主题编辑` 模式
  - 会强制激活 `richpost-layout-designer` + `richpost-theme-editor`
  - 左侧 `首页 / 内容页 / 尾页` 预览上的矩形会直接编辑当前主题的 `coverFrame / bodyFrame / endingFrame`
  - 这三个 frame 决定最终真实文字区域；主题的字体、字号、行高、颜色仍然由 `layout.tokens.json` 与母版控制
  - 每张预览下都可以单独上传背景图，图片会复制进当前工作区的 `themes/richpost-theme-assets/<theme-id>/`，文件名使用时间戳重命名，并写回当前主题的 `coverBackgroundPath / bodyBackgroundPath / endingBackgroundPath`
  - 矩形调整会自动写回当前主题文件并立即重渲染当前工程页面
  - AI 必须优先按 `layout.tokens.json`、`masters/cover.master.html`、`masters/body.master.html`、`masters/ending.master.html` 的顺序理解和修改模板层
- 图文主题抽屉里右击任一主题时：
  - 会出现 `编辑 / 重命名 / 删除`
  - `编辑` 对所有主题都可用；右击内置主题时会先基于它创建当前工程自己的副本，再进入全屏编辑页
  - `重命名 / 删除` 只对 `themes/richpost-themes.json` 里的自定义主题生效
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
- richpost 页面的最终渲染改成 `tokens + master + page-plan` 合成，不再走写死的 Rust 模板分支
- 前端预览直接读取真实文件，不在渲染层拼接大段 HTML 字符串
- `layout.html` 只做预览壳，把多页卡片拆到 `pages/` 下独立加载

## 备选说明

长文工程保留方案二，是因为长文阅读页更依赖全文语义和整体版式；图文工程改成自动重排，是因为小红书图文的编辑频率高，正文一改就应立即得到新的稳定分页结果。
