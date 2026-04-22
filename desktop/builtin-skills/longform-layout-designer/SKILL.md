---
allowedRuntimeModes: [chatroom]
hookMode: inline
autoActivate: false
activationScope: session
contextNote: 当前文件会话处于 longform 长文排版模式。正文真相层仍是 content.md；样式层和母版层是 manifest.longformLayoutPresetId、layout.html、wechat.html。排版优化必须保持正文内容不变。
promptPrefix: 你当前必须遵守 longform-layout-designer。凡是当前稿件页里的长文排版、长文母版、分栏、字体、留白和 HTML 样式优化，都先按这份技能处理；优先改长文母版和 layout/wechat HTML，不要改 content.md 正文。
promptSuffix: 完成长文排版任务时，必须保持 Markdown 正文原文不被改写；不要补写额外标题、总结、过渡语或解释性文案；不要引入外部字体 URL、远程 CSS 或远程 JS。
maxPromptChars: 2600
---
# Longform Layout Designer

用于稿件页 `长文排版` 模式的专用技能。

## 适用范围

- 长文母版切换
- `layout.html` 长文阅读页优化
- `wechat.html` 公众号排版优化
- 标题层级、分栏、导语、引用、留白和节奏调整

如果任务是正文改写、补写、润色，或 richpost 图文分页 / 主题调整，不要让本技能主导。

## 工程真相层

- `content.md`：正文唯一真相层
- `manifest.longformLayoutPresetId`：长文母版选择
- `layout.html`：长文排版预览页
- `wechat.html`：公众号排版预览页

## 工作流

1. 先判断用户要改的是母版、视觉层级，还是具体某个 HTML 目标。
2. 只需要换整体气质时：
   - 优先改 `manifest.longformLayoutPresetId`
3. 需要精调版面时：
   - 针对 `layout.html` / `wechat.html` 调整结构和样式层
4. `layout.html` 可以使用更强的阅读版式，例如分栏、跨栏标题、章节卡片。
5. `wechat.html` 仍以公众号正文习惯为准，保持单栏阅读，不做真实多栏正文。

## 强制规则

- 不要改写、删减、扩写、总结或重组 `content.md` 正文，除非用户明确要求改内容。
- 不要凭空新增解释性文案、页脚总结、封面口号或占位标题。
- 不要引入外部字体链接、在线 CSS 或远程 JS。
- 换字体时只用系统字体栈，例如：
  - `PingFang SC / Hiragino Sans GB / Microsoft YaHei`
  - `Source Han Serif SC / Songti SC / STSong`
  - `Kaiti SC / STKaiti / KaiTi`
- 如果当前目标是 `wechat.html`，不要做真实双栏正文或网页导航结构。

## 默认取舍

- 用户只说“优化排版”时，默认先改母版、字体、层级、留白和章节结构，不改正文层。
- 用户只说“换一种感觉”时，默认先切长文母版，再细调 HTML。
- 用户没有明确要求重写正文时，不主动更改文字内容。
