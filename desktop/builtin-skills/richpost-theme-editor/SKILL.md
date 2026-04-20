---
allowedRuntimeModes: [chatroom]
allowedTools: [app_cli, redbox_fs]
hookMode: inline
autoActivate: false
activationScope: session
contextNote: 当前文件会话处于 richpost 图文主题编辑模式。目标不是改正文，而是调整当前稿件包内当前 theme root 的 theme.json、tokens、母版和真实文字区域 frame，让主题编辑页左侧三张预览反映真实模板结果。
promptPrefix: 你当前必须遵守 richpost-theme-editor。当前任务是修改当前稿件包内的 richpost 模板层，而不是改正文内容。先把页面理解成首页、内容页、尾页三类母版；当前主题还包含 coverFrame、bodyFrame、endingFrame 三个真实文字区域。优先修改当前 theme root 里的 theme.json、layout.tokens.json 和 masters/*.master.html，只有在母版、tokens 和 frame 不足以达成目标时，才调整 page-plan.json 的 master、zones 或 styleOverrides。
promptSuffix: 不要改 content.md，不要改 content-map.json，不要直接在 pages/page-xxx.html 里手写正文，也不要补写额外文案。模板调整完成后，结果必须仍然由当前工程的 tokens、masters 和 page-plan 渲染出来；未读回当前稿件包内的 tokens 或预览前，不要宣称修改已经成功。
maxPromptChars: 3200
---
# Richpost Theme Editor

用于稿件页 `图文主题编辑` 全屏页面的专用技能。

## 适用范围

- richpost 主题编辑页里的模板修改
- 首页、内容页、尾页三种版式的结构调整
- 文字区域、安全区、标题区、图片区的布局重设
- layout tokens、母版 HTML、分页方案的样式与结构联动

如果任务是正文改写、标题润色、内容扩写、压缩段落，或普通图文排版微调，不要让本技能主导。

## 当前工程真相层

- `content.md`：正文唯一真相层
- `content-map.json`：正文块映射，宿主自动生成
- `themes/index.json`：当前稿件包的主题目录索引，只用于列出主题摘要
- `themes/<theme-id>/theme.json`：当前主题主配置文件，`coverFrame / bodyFrame / endingFrame` 与 `coverBackgroundPath / bodyBackgroundPath / endingBackgroundPath` 保存在这里
- `themes/<theme-id>/layout.tokens.json`：当前主题自己的 token 真相层
- `themes/<theme-id>/masters/*.master.html`：当前主题自己的母版真相层
- `themes/<theme-id>/page-plan.json`：当前主题自己的分页方案真相层
- `themes/<theme-id>/assets/`：当前主题自己的背景图与素材目录
- `richpost-theme-template.md`：空白主题模板说明文件，给 AI 和开发者解释可编辑字段、编辑边界和默认规则
- `layout.tokens.json`：主题 token，控制颜色、字号、行高、边距、宽度、圆角、阴影等基础样式
- `masters/cover.master.html`：首页母版
- `masters/body.master.html`：内容页母版
- `masters/ending.master.html`：尾页母版
- `richpost-page-plan.json`：页面使用哪张母版、哪些 block 进入哪个 zone
- `layout.html`：图文总览壳
- `pages/page-xxx.html`：最终渲染结果，只是产物，不是主题编辑主目标

## 工作顺序

1. 先判断需求属于哪一层：
   - 真实文字区域：改 `themes/<theme-id>/theme.json` 里的 `coverFrame / bodyFrame / endingFrame`
   - 视觉风格：改 `themes/<theme-id>/layout.tokens.json`
   - 页面结构：改 `themes/<theme-id>/masters/*.master.html`
   - 页面内容分配或 zone 绑定：改 `themes/<theme-id>/page-plan.json`
2. 默认优先级固定为：
   - `richpost-theme-template.md`
   - `themes/<theme-id>/theme.json`
   - `themes/<theme-id>/layout.tokens.json`
   - `themes/<theme-id>/masters/*.master.html`
   - `themes/<theme-id>/page-plan.json`
3. 只有在前两层做不到的时候，才触碰分页方案。
4. 不要把临时效果直接写死到 `pages/page-xxx.html`，除非宿主明确要求你保存最终渲染产物。

## 模板编辑规则

- 首页、内容页、尾页必须被当成三种独立母版处理。
- 可以新增或调整这些模板元素：
  - 背景层
  - 图片层
  - 遮罩层
  - 标题容器
  - 正文容器
  - 标签条
  - 装饰线
  - 卡片容器
  - 引文框
- 可以调整文字区域的：
  - 宽度
  - 高度
  - 对齐
  - 内边距
  - 相对位置
  - 与图片区的层级关系
- 文字区域的真实矩形由：
  - `coverFrame`
  - `bodyFrame`
  - `endingFrame`
  控制。主题编辑页左侧的矩形就是这三个字段的可视化编辑层。
- 三个母版的背景图来源于：
  - `coverBackgroundPath`
  - `bodyBackgroundPath`
  - `endingBackgroundPath`
  它们都指向当前主题 root 里的 `assets/` 图片资产。
- 可以让首页、内容页、尾页使用完全不同的布局。

## 强制限制

- 不要使用 `bash` / 终端命令直接改主题文件。
- 不要通过 `/tmp`、临时文件、`cat | sed | mv` 这类 shell 流水线改写工作区文件。
- 读取主题文件时优先使用 `redbox_fs`；保存主题修改时优先使用 `app_cli(command="manuscripts theme ...")`。
- 不要改全局主题目录，例如 `~/.redbox/themes/richpost-themes.json`。当前会话只能处理当前稿件包内的主题文件。
- 不要改写、删减、扩写或重组 `content.md` 正文。
- 不要手改 `content-map.json`。
- 不要在模板里硬编码正文文字。
- 不要新增“总结页”“收束页”“小红书图文”这类正文外文案。
- 不要引入外部字体 URL、外部 CSS 或远程 JS。
- 如需换字体，只能用系统字体栈或宿主已有 preset。
- 如果工具调用失败，必须明确报告失败，不能继续宣称“已完成”。
- 宣称主题修改完成前，必须至少满足其一：
  - 读回当前稿件包内当前 theme root 的 `theme.json` / `layout.tokens.json` 看到了目标变更
  - 或拿到当前稿件包的预览/状态返回，确认主题已经应用到当前稿件

## 默认取舍

- 用户只说“改主题”时，默认先改 `layout.tokens.json`。
- 用户提到首页、尾页、文字区域、图文比例、内容容器时，默认改 `masters/*.master.html`。
- 用户提到某一页该放哪些内容，或哪段内容应该落在哪个区域时，再改 `richpost-page-plan.json`。
- 如果只是让预览更像真实主题，不要只做颜色替换，要以模板文件为主目标。
