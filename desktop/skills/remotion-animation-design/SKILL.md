---
allowedRuntimeModes: [video-editor]
allowedTools: [redbox_editor, redbox_fs]
hookMode: inline
autoActivate: true
contextNote: 默认按“动画主体来源 -> 对象表达 -> 时间范围 -> 动画类型 -> 预览验证”的顺序设计 Remotion 动画图层。独立动画图层默认不绑定底层片段，不允许通过普通文字轨伪装动画。共享动画元素优先从 workspace 根目录下的 remotion-elements/ 读取并复用。
promptPrefix: 你当前必须遵守 remotion-animation-design 技能：先确定动画主体从哪来（手绘/图形、图标/SVG、文字、已有素材），再决定对象表达，之后才决定时间与动画；如果主体没有对象表达，就不能宣称动画已完成。
promptSuffix: 生成动画时，默认目标是更新 animation layer / M* 动画轨并进入预览，不默认导出文件。优先输出 entities 与 animations，不要把对象动画退化成说明文字；若用户未明确要求文字层，默认不要生成标题、说明、字幕或 overlays。
---
# remotion-animation-design

用于视频编辑运行时的 Remotion 动画设计流程技能。

## 核心流程

1. 先读脚本与当前动画上下文，确认动画是独立图层还是显式绑定镜头。
2. 先判断动画主体来源，再决定对象表达：
   - 手绘/几何图形：`shape`
   - 图标/品牌图形：`svg`
   - 标题/文案：`text`
   - 已有图片/视频素材：`image` / `video`
3. 只有对象被表达成 `entities[]` 后，才进入动画设计；没有对象表达，不要用说明文字代替。
   默认不要额外生成标题、说明或字幕层；除非用户明确要求屏幕文字。
4. 动画默认由时间驱动：
   - 先确定 `fromMs` / `durationMs`
   - 再确定 `startFrame` / `durationInFrames`
   - 默认位置坐标使用 `canvas-space`
   - 如果需要与视频元素精准对位，改用 `video-space`，并明确 `referenceWidth` / `referenceHeight`
   - `x / y` 表示实体最终停留位置的左上角坐标，不是中心点；需要居中时按参考尺寸和实体尺寸自行计算
   - `fall-bounce` 的 `fromY` / `floorY` 是相对位移；常规下落动画应把最终落点写在 `entity.y`，并让 `floorY = 0`
5. 动画类型优先使用宿主支持的 `animations[]`：
   - `fade-in`
   - `fade-out`
   - `slide-in-left`
   - `slide-in-right`
   - `slide-up`
   - `slide-down`
   - `pop`
   - `fall-bounce`
   - `float`
6. 动画只能进入动画轨：
   - `animationLayers[]`
   - `M*` 轨投影项
   不允许用 `text_add` / `subtitle_add` 往普通轨道模拟动画。
7. 生成后先让用户在编辑器里预览和调整；除非明确要求，不要继续导出。

## 共享元素库

- 工作区级共享动画元素库路径：`remotion-elements/`
- 在设计动画前，如存在合适模板，优先复用共享元素而不是重新发明。
- 读取共享库时优先用 `redbox_fs` 查看 `remotion-elements/` 下的 JSON 资源。

## 何时绑定片段

- 只有用户明确要求“跟随某个已有镜头/素材”时，才写 `bindings` 或 `clipId / assetId`。
- 否则默认：
  - `bindings = []`
  - 动画作为独立时间层存在

## 参考

- 动画主体来源与对象表达规则：见 [references/subject-sourcing.md](references/subject-sourcing.md)
- 宿主当前动画层字段与能力边界：见 [references/schema.md](references/schema.md)
