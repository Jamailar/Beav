# `src/components/manuscripts/`

这里是稿件编辑和视频/音频工作台的核心前端区域，包含文字稿件、时间线、预览、Remotion 场景编辑以及 vendored timeline 适配。

## Main Responsibilities

- 稿件编辑器和工具栏
- 视频/音频工作台
- 时间线与轨道 UI
- Remotion 预览阶段壳层
- FreeCut vendored timeline 桥接

## High-Risk Files

- `VideoDraftWorkbench.tsx`
- `AudioDraftWorkbench.tsx`
- `EditableTrackTimeline.tsx`
- `VendoredFreecutTimeline.tsx`
- `freecutTimelineBridge.ts`
- `editorProject.ts`

## Rules

- 编辑器协议优先统一在 `editorProject.ts` 和共享类型层，不要在多个组件里各自发明字段。
- 时间线和预览相关改动要同时考虑 React UI、vendored FreeCut 桥和 Remotion 预览。
- 重交互组件避免在 render 阶段做大规模转换。

## Verification

- 打开稿件页并切换不同 draft 类型
- 验证选中、拖拽、时间线滚动、预览更新
- 如改动 FreeCut 适配，验证 vendored timeline 未断裂
