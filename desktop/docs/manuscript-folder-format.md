---
doc_type: plan
execution_status: completed
last_updated: 2026-05-07
---

# Manuscript Folder Format

RedConvert 稿件工程使用普通文件夹管理，不再使用自定义稿件扩展名或 ZIP 容器。

## Detection

一个目录只要包含 `manifest.json`，就被视为稿件工程。类型只能从 `manifest.json` 读取：

- `packageKind: "post"`
- `packageKind: "article"`
- `packageKind: "video"`
- `packageKind: "audio"`

文件名、目录名和扩展名不能作为工程类型来源。

## Entries

- `post` / `article` 默认入口是 `content.md`
- `video` / `audio` 默认入口是 `script.md`
- `manifest.entry` 可以显式覆盖入口

绑定、素材、变体和渲染资产都保存在工程目录内的普通文件里，例如 `bindings.json`、`assets.json`、`variants/<platform>.md`。
