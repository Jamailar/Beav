---
name: assets
---

# Assets

- 先确认素材来源：shape / svg / text / image / video。
- 只有明确要求使用已有素材时，才绑定 `clipId` / `assetId` 或使用 `image` / `video` entity。
- 若任务没有依赖素材文件，优先使用宿主可渲染的 shape / text / svg。
- 对已有素材的尺寸、时长、路径判断，先依赖 `remotion_read` 返回的 `assetMetadata`。
