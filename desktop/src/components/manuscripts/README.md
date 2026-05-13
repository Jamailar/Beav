# `src/components/manuscripts/`

这里是稿件编辑和音频工作台的核心前端区域，包含文字稿件、素材绑定、音频时间线和预览。

## Main Responsibilities

- 稿件编辑器和工具栏
- 音频工作台
- 音频时间线与轨道 UI

## High-Risk Files

- `AudioDraftWorkbench.tsx`
- `EditableTrackTimeline.tsx`
- `editorProject.ts`

## Rules

- 编辑器协议优先统一在 `editorProject.ts` 和共享类型层，不要在多个组件里各自发明字段。
- 时间线和预览相关改动要同时考虑 React UI 与持久化协议。
- 重交互组件避免在 render 阶段做大规模转换。

## Verification

- 打开稿件编辑器并切换不同 draft 类型
- 验证选中、拖拽、时间线滚动、预览更新
