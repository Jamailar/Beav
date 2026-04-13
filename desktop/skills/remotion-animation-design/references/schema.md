# 宿主动画层 schema 约束

当前动画设计应优先写入：
- `animationLayers[]`
- `entities[]`
- `animations[]`

默认结构：
- 一个视频工程对应一个 `remotion.scene.json`
- 默认存在一个主 scene（通常是 `scene-1`）
- 新动画默认是在主 scene 中新增/更新 `entities[]` 与 `animations[]`

## animation layer 核心字段
- `id`
- `name`
- `enabled`
- `fromMs`
- `durationMs`
- `zIndex`
- `renderMode`
- `componentType`
- `props`
- `entities`
- `bindings`

## entities 当前支持
- `text`
- `shape`
- `image`
- `svg`
- `video`
- `group`

## animations 当前支持
- `fade-in`
- `fade-out`
- `slide-in-left`
- `slide-in-right`
- `slide-up`
- `slide-down`
- `pop`
- `fall-bounce`
- `float`

## 禁止事项
- 不要把对象动画降级成说明文字
- 不要通过普通文字轨承载动画
- 不要默认按底层片段数量拆动画
