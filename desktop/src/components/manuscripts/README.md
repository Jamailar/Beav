# `src/components/manuscripts/`

这里是稿件编辑的核心前端区域，包含文字稿件、素材绑定、包状态预览和视频导出入口。

## Main Responsibilities

- `ManuscriptEditorHost.tsx`：编辑器页面 host，负责数据加载、当前编辑状态和 UI composition。
- `../../features/manuscripts/editorModel.ts`：稿件树、素材分类、草稿卡片、生成素材投影、导出尺寸等纯 model/helper。
- `WritingDraftWorkbench.tsx`：沉浸式写作工作台。
- `ManuscriptToolbar.tsx`、`CodeMirrorEditor.tsx`、`GraphView.tsx`：局部编辑控件。

## Rules

- 重交互组件避免在 render 阶段做大规模转换。
- 树、素材和卡片 projection 优先放在 `features/manuscripts/editorModel.ts`，页面只做 memoized composition。

## Verification

- 打开稿件编辑器并验证文字稿件读写。
- 验证创建/重命名/删除文件夹与草稿。
- 验证包素材绑定、Remotion 场景保存和导出入口。
