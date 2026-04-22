---
name: calculate-metadata
---

# Calculate Metadata

- 官方 Remotion 通过 `calculateMetadata` 在渲染前解析 Composition 的最终宽高、fps、时长、默认输出名和默认编码参数。
- 在当前宿主里，AI 不直接编写 `calculateMetadata` 代码；要通过完整填写 `remotion.scene.json` 顶层字段和 `render` 默认值来驱动它。
- 需要稳定保留：
  - `entryCompositionId`
  - `width`
  - `height`
  - `fps`
  - `durationInFrames`
  - `renderMode`
  - `render.defaultOutName`
  - `render.codec`
  - `render.imageFormat`
  - `render.pixelFormat`
  - `render.proResProfile`
- 默认导出约定：
  - `renderMode=motion-layer` -> `codec=prores`, `imageFormat=png`, `pixelFormat=yuva444p10le`, `proResProfile=4444`
  - `renderMode=full` -> `codec=h264`, `imageFormat=jpeg`
- 若任务只是追加动画元素，不要无故改动 Composition 元数据和导出默认项。
