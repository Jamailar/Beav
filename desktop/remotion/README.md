# `remotion/`

本目录放 Remotion 的 Node 侧渲染脚本，不是 React composition 代码本身。

## Entry Point

- [render.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/remotion/render.mjs)

## Responsibilities

- 读取 composition config
- 收集并临时复制本地素材
- 调用 Remotion bundler / renderer
- 输出渲染结果和进度事件

## Rules

- 本地素材路径兼容 `redbox-asset://`、`file://`、绝对路径
- 渲染脚本只负责渲染准备和执行，不承担页面逻辑
- 调整素材协议时要同步 `shared/localAsset.ts`

## Verification

- 跑一次 `pnpm remotion:render`
- 验证本地素材 staging 和清理逻辑
