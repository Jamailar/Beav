# `src/remotion/`

本目录是 Remotion 的 React 入口，负责定义渲染根组件和 composition 组装。

## Entry Points

- [index.ts](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src/remotion/index.ts)
- [Root.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src/remotion/Root.tsx)

## Relationship

- CLI 渲染脚本在 [remotion/render.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/remotion/render.mjs)
- 编辑器侧协议和预览壳层在 `src/components/manuscripts/`
- 视频编辑器状态在 `src/features/video-editor/`

## Rules

- Composition 输入应来自稳定协议，不直接绑页面内部临时状态。
- 路径、素材、比例和导出模式变化要同步验证 CLI 渲染脚本。
