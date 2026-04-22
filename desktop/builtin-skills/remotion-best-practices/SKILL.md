---
allowedRuntimeModes: [video-editor]
allowedTools: [redbox_editor, redbox_fs, app_cli]
hookMode: inline
autoActivate: true
contextNote: 当前视频运行时默认启用 Remotion 官方最佳实践知识包。优先按 Composition / Sequence / timing / assets 的思路设计动画，但最终仍以 remotion.scene.json 与 editor.project.json 为宿主真相层。
promptPrefix: 你当前必须遵守 remotion-best-practices：先读取当前 Remotion 工程状态，再决定 composition/scene 边界、主体 element、timing 与 assets；不要直接虚构任意 React 代码或 CSS 动画。
promptSuffix: 只使用宿主支持的 Remotion scene/entity/animation 能力落地结果。若官方 Remotion 能力超出宿主范围，必须显式降级为可预览的 scene patch，而不是假装已实现。
---
# Remotion Best Practices

用于 `video-editor` 运行时的内置 Remotion 官方最佳实践技能。

## 工作目标

1. 在动手生成或修改动画前，先读取当前 Remotion 工程状态。
2. 先明确 Composition / scene 边界，再确定主体 element、timing、assets 与字幕。
3. 生成结果必须回到宿主的 `remotion.scene.json` / `editor.project.json`，而不是变成脱离宿主的自由 TSX 代码。

## 宿主映射

- Remotion Composition 配置 ~= `remotion.scene.json` 顶层 project/config
- Sequence / staged scene ~= `scenes[]`
- React element abstraction ~= `entities[]`
- `useCurrentFrame()` 驱动的 timing mapping ~= `animations[]` + `startFrame` / `durationInFrames`
- 宿主目前不支持直接执行 CSS transitions、Tailwind animate class、任意 React 库组件

## 工作流

1. 先 `redbox_editor(action="remotion_read")` 读取当前 Composition、scene、selection 与 asset metadata。
2. 运行时会自动加载内置 `rules/*.md`，覆盖 compositions / animations / sequencing / timing / assets / text-animations / subtitles / transitions / calculate-metadata。
3. 设计 scene patch 时，优先保留现有 Composition 元数据与未触及 entities。
4. 生成后通过 `remotion_generate` / `remotion_save` 回写宿主工程。

## 强制约束

- 禁止用普通文字轨冒充对象动画。
- 若脚本没有明确要求屏幕文字，默认不要生成 `overlayTitle`、`overlayBody`、`overlays` 或解释性 `text` entity；优先只保留动画主体。
- 禁止在 Remotion 层使用 CSS transition、CSS animation 或 Tailwind animate 类名。
- 若需要切换、字幕、素材测长等能力，必须先映射到宿主当前支持的数据结构。
- 导出相关默认项必须通过 Composition 顶层字段与 `render` 配置表达，保持预览与导出一致。
