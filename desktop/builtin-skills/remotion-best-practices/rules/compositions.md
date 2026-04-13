---
name: compositions
---

# Compositions

- 一个视频工程默认对应一个宿主 Remotion 工程文件。
- 默认维护一个主 scene；只有用户明确要求分段场景时，才拆成多个 `scenes[]`。
- 修改动画时优先保留顶层 `title`, `width`, `height`, `fps`, `durationInFrames`, `backgroundColor`, `renderMode`。
- 若任务只是追加动画元素，不要重建整个 Composition。
