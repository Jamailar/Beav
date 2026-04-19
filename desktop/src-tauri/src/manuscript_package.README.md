# `manuscript_package.rs`

稿件工程模块。

当前采用混合协议：

- `*.redpost` 图文工程：方案一
- `*.redarticle` 长文工程：方案二

## 工程文件结构

长文工程 `*.redarticle`

- `manifest.json`
- `content.md`
- `layout.html`
- `wechat.html`
- `cover.json`
- `images.json`
- `assets.json`

图文工程 `*.redpost`

- `manifest.json`
- `content.md`
- `content-map.json`
- `layout.template.html`
- `layout.html`
- `cover.json`
- `images.json`
- `assets.json`

## 正式链路

图文工程 `*.redpost`

1. Markdown 是唯一正文源。
2. 保存稿件时，宿主把 Markdown 解析成 `content-map.json`。
3. 模板 HTML 只负责结构、样式、素材槽位、文本槽位，不直接保存正文原文。
4. 宿主把 `content-map.json` 和素材绑定渲染进模板，输出最终 `layout.html`。

长文工程 `*.redarticle`

1. Markdown 仍然是正文源。
2. `layout.html` / `wechat.html` 由 AI 直接读取整份 Markdown 后全量生成。
3. 长文保存正文时不会自动重排 HTML，只有显式点击生成按钮才会更新。

## 宿主命令

- `manuscripts:generate-package-template`
- `manuscripts:save-package-template`
- `manuscripts:render-package-html`
- `manuscripts:generate-package-html`
- `manuscripts:save-package-html`

命令职责：

- `generate/save-package-template`：图文工程模板链路
- `generate/save-package-html`：长文工程最终 HTML 链路
- `render-package-html`：图文工程按内容映射重渲染

## 触发规则

- 新建图文工程时，默认写入模板文件、内容映射文件和首版渲染 HTML。
- 新建长文工程时，默认只初始化最终 HTML 资产文件。
- 图文保存 Markdown 正文时，自动重建 `content-map.json` 并重渲染 HTML。
- 长文保存 Markdown 正文时，不自动重排 HTML。
- 图文绑定封面 / 配图后，自动重渲染 HTML。
- 长文绑定封面 / 配图后，只更新工程索引，等显式生成时再由 AI 使用。

## 备选方案

备选方案二已经写入文档：

- [docs/manuscript-package-html-architecture.md](../../docs/manuscript-package-html-architecture.md)

该文档已经更新为混合协议说明，其中长文默认采用方案二。
