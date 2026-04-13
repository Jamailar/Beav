---
name: sequencing
---

# Sequencing

- 使用显式 `startFrame` 和 `durationInFrames` 表达出现时间。
- 一个 scene 内的 overlays 与 entities 必须落在 scene 时间范围内。
- 若任务是“场景内延迟出现”，优先调整 entity / overlay 的 `startFrame`，而不是新建无意义 scene。
- 若任务是“后一个场景接上前一个场景”，再考虑拆 scene。
