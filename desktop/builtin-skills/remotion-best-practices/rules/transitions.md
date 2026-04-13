---
name: transitions
---

# Transitions

- 只有明确是场景切换任务时，才处理 transition 语义。
- 当前宿主没有完整 `TransitionSeries` DSL；若用户要求切换效果，优先降级为：
  - 相邻 scene 的显式时间衔接
  - 可表达的 overlay 入场/退场
  - 宿主已有 scene / overlay timing
- 不能映射的切换效果要在摘要里明确说明降级，而不是静默丢弃。
