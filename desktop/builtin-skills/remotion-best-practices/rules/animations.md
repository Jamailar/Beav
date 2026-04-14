---
name: animations
---

# Animations

- 所有动画都必须是按帧驱动的，不要依赖 CSS transitions 或浏览器动画类名。
- 进入/退出/强调动画优先映射到宿主支持的 `animations[]`：
  - `fade-in`
  - `fade-out`
  - `slide-in-left`
  - `slide-in-right`
  - `slide-up`
  - `slide-down`
  - `pop`
  - `fall-bounce`
  - `float`
- 若官方 Remotion 示例使用 `interpolate()` 或 `spring()`，最终要把它压缩为宿主支持的 animation kind 与必要参数。
- `animations[]` 必须使用宿主 schema：
  - `id`
  - `kind`
  - `fromFrame`
  - `durationInFrames`
  - `params`
- 不要把 `fromY`、`toY`、`bounceCount`、`durationFrames` 等字段直接挂在 animation 根节点。
- 对 `fall-bounce`，优先把运动参数放进 `params.fromY / params.floorY / params.bounces / params.decay`。
