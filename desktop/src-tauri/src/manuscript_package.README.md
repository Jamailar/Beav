# `manuscript_package.rs`

稿件工程模块。稿件工程现在统一使用普通文件夹，不再使用自定义稿件扩展名或单文件容器。

## 工程结构

最小结构：

- `manifest.json`
- `content.md` 或 `script.md`

按类型补充：

- `packageKind=post`：`content.md`、`bindings.json`、`variants/`
- `packageKind=article`：`content.md`、`cover.json`、`images.json`、`assets.json`
- `packageKind=video`：`script.md`、`assets.json`、`remotion.scene.json`、`editor.project.json`
- `packageKind=audio`：`script.md`、`assets.json`、`timeline.otio.json`、`editor.project.json`

类型只从 `manifest.json` 的 `packageKind` / `kind` 读取。路径、文件名和扩展名不能作为类型判断依据。

## 模块职责

- `src-tauri/src/commands/manuscripts.rs`：创建、保存、绑定、variant、渲染和导出。
- `src-tauri/src/manuscript_package.rs`：读取工程状态并暴露结构化信息给前端。
- `src-tauri/src/helpers.rs`：识别 `manifest.json` 文件夹、读写工程内部 entry。

正文或脚本文件仍是内容真相层；视觉配置、媒体绑定和导出资产由宿主按需维护。
