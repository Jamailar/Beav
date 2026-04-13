# 动画主体来源

先判断动画主体来自哪一类，再决定怎么做：

## 1. 手绘 / 图形对象
- 适合：苹果、球、卡片、背景块、几何元素
- 优先：`entities[].type = "shape"`
- 当前 shape 优先用：`rect`, `circle`, `apple`

## 2. 图标 / SVG
- 适合：logo、icon、品牌标识
- 优先：`entities[].type = "svg"`

## 3. 文字
- 适合：标题、标语、字幕、强调语
- 优先：`entities[].type = "text"`

## 4. 已有素材
- 适合：用户明确要求使用导入图片或视频
- 优先：`entities[].type = "image"` / `"video"`

默认顺序：
1. 文字
2. shape
3. svg
4. 已有素材

如果用户没有明确要求素材来源，不要默认绑定到底层素材。
