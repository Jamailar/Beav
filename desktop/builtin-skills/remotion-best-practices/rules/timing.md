---
name: timing
---

# Timing

- 优先使用清晰、显式的 frame range，而不是模糊的“快一点 / 慢一点”。
- 宿主里所有 timing 最终都要转成：
  - `startFrame`
  - `durationInFrames`
  - `animations[].fromFrame`
  - `animations[].durationInFrames`
- 当设计稿是典型的 ease-in / ease-out / spring / bezier 节奏时，保留运动意图并映射到最接近的宿主动画种类，不要发明新的 DSL。
