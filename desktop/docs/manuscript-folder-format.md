---
doc_type: plan
execution_status: completed
last_updated: 2026-07-01
---

# Manuscript Folder Format

RedConvert 稿件工程使用普通文件夹管理，不再使用自定义稿件扩展名或 ZIP 容器。长期项目文件留在用户可管理的工程目录中，`.redbox` 只保存临时任务、缓存、日志和诊断材料。

## Minimal Project Protocol

工程目录的唯一强约束是：根目录必须包含 `manifest.json`。目录内部结构按项目需要自然增长，不要求所有项目都预置同一批子目录。

## Standalone Preview Files

稿件树也支持普通主体文件，不要求所有内容都升级为工程目录：

- `.md`：Markdown 主体，可在编辑器内编辑 / 预览，并可绑定媒体库素材。
- `.html`：HTML 主体，可在编辑器内编辑，并通过 sandbox iframe 预览。

除 `.md` / `.html` 外的普通文件不会作为稿件主体出现在稿件树；它们应作为媒体库素材、知识库文件或工程目录内部文件存在。

AI 创建长期项目时，优先使用通用 workspace 文件能力创建目录和写入文件：

1. `workspace.createDirectory` 创建项目目录。
2. `workspace.write` 写入 `manifest.json`。
3. `workspace.write` 写入入口文件和按需生成的素材索引、字幕、计划、导出记录等。

不要为每种项目类型新增专用 create tool；只有转写、媒体编辑、图像/视频生成、TTS、embedding、外部集成这类重能力需要专用工具。

最小 manifest：

```json
{
  "version": 1,
  "id": "project_xxx",
  "type": "manuscript-package",
  "packageKind": "article",
  "title": "项目名",
  "entry": "content.md",
  "files": []
}
```

`files` 是长期相关文件索引，路径必须是工程内相对路径，不允许 `..` 越界。推荐字段：

```json
{
  "id": "file_xxx",
  "role": "transcript",
  "path": "transcripts/source.zh.srt",
  "sourceFileId": "asset_xxx",
  "format": "srt",
  "createdAt": "2026-05-13T00:00:00Z"
}
```

常见 `role`：`entry`、`source`、`asset`、`transcript`、`output`、`plan`、`note`、`metadata`。

推荐但不强制的目录：

- `assets/`
- `transcripts/`
- `outputs/`
- `sources/`
- `ai/`

例如字幕识别成功后，正式字幕应进入项目目录：

```text
manuscripts/<project>/
  manifest.json
  script.md
  transcripts/source.zh.srt
```

抽音频、原始接口响应、job 诊断等仍可保存在 `.redbox/media-transcripts/<jobId>/`。

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
