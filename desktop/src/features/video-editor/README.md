# `src/features/video-editor/`

本目录承载视频编辑器的特性级状态和后续聚合逻辑。目前核心是 store，但它代表整个视频编辑器的前端状态边界。

## Entry Point

- [store/useVideoEditorStore.ts](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src/features/video-editor/store/useVideoEditorStore.ts)

## State Areas

- project
- assets
- timeline
- timelinePreview
- selection
- player
- scene
- panels
- remotion
- script
- editor

## Rules

- 新增视频编辑交互时，优先扩展统一 store，而不是在多个组件里维护平行状态。
- 需要持久化或 host 交互的数据，不要直接塞成组件私有状态。
- 复杂状态变更优先保持同一来源，避免 timeline、preview、scene 三套状态互相漂移。

## Verification

- 验证选中态、播放态、时间线和场景状态同步
- 验证 store 更新不会导致明显重渲染卡顿
