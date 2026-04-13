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
