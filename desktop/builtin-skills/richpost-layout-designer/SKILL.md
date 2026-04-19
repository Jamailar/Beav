---
allowedRuntimeModes: [chatroom]
hookMode: inline
autoActivate: false
activationScope: session
contextNote: 当前文件会话处于 richpost 图文排版模式。正文真相层仍是 content.md；分页和样式层是 content-map.json、richpost-page-plan.json、layout.html、pages/page-xxx.html 与 manifest.richpostThemeId。排版优化必须保持正文内容不变。
promptPrefix: 你当前必须遵守 richpost-layout-designer。凡是当前稿件页里的图文排版、主题、字体、分页、页面样式优化，都先按这份技能处理；优先改 richpost 的样式层和分页层，不要改 content.md 正文。
promptSuffix: 完成 richpost 图文排版任务时，必须保持 Markdown 正文原文不被改写，不得补写额外标题、总结、收束语或解释性文案；如需换字体，只能使用系统字体栈或宿主提供的字体 preset，不要引入外部字体 URL。
maxPromptChars: 2600
---
# Richpost Layout Designer

用于稿件页 `图文排版` 模式的专用技能。

## 适用范围

- richpost 图文主题切换
- richpost 字体、字号、行距、留白、层级调整
- richpost 页面结构、图片位置、卡片样式优化
- richpost 分页方案和页面 HTML 微调

如果任务是正文改写、补写、扩写、压缩、润色，或长文 `layout.html / wechat.html` 调整，不要让本技能主导。

## 工程真相层

- `content.md`：正文唯一真相层
- `content-map.json`：正文结构化块映射
- `richpost-page-plan.json`：图文分页方案
- `manifest.richpostThemeId`：图文主题选择
- `layout.html`：图文总览壳
- `pages/page-xxx.html`：每一页最终预览 HTML

## 工作流

1. 先判断用户要改的是主题、字体、页面样式，还是分页结构。
2. 主题或视觉微调：
   - 优先改 `manifest.richpostThemeId`
   - 不够时，再改 `pages/page-xxx.html` / `layout.html` 的样式层
3. 分页或页面结构调整：
   - 优先保持现有 block 文本和块顺序
   - 只在明确需要时调整 `richpost-page-plan.json` 或页面容器结构
4. 完成后保证预览与导出一致，仍然是 `3:4` 页面。

## 强制规则

- 不要改写、删减、扩写、总结或重组 `content.md` 正文，除非用户明确要求改内容。
- 不要往页面里额外补“小红书图文”“收束页”“总结页”“观点页”这类正文外标签。
- 不要凭空新增解释性文案、页脚总结、过渡文案或占位标题。
- 不要引入外部字体链接、在线 CSS 或远程 JS。
- 换字体时只用系统字体栈，例如：
  - `PingFang SC / Hiragino Sans GB / Microsoft YaHei`
  - `Songti SC / STSong / Source Han Serif SC`
  - `Kaiti SC / STKaiti / KaiTi`
- 图文页始终保持图片稿件当前的导出约束：预览和导出要用同一份页面 HTML。

## 默认取舍

- 用户只说“优化排版”时，默认先改视觉层，不改正文层。
- 用户只说“换一种感觉”时，默认先改主题、字体、留白、图片处理和层级。
- 用户没有明确要求重排内容时，不主动改 block 归属和页顺序。
