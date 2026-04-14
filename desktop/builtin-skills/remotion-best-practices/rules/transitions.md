---
name: transitions
---

# Transitions

- 场景切换使用顶层 `transitions[]`，不要把转场偷偷写成说明文字或普通文字轨。
- 当前宿主支持的转场 presentation 以 `fade / wipe / slide / flip / clockWipe / iris` 为主，底层由 Remotion 预览和导出共用同一套 transition engine。
- 每个 transition 都必须显式填写：
  - `leftClipId`
  - `rightClipId`
  - `presentation`
  - `timing`
  - `durationInFrames`
- 若官方示例里的转场能力超出宿主支持范围，必须明确降级到最接近的 presentation，而不是静默丢失。
