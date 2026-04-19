# `src/features/`

本目录放垂直功能特性，适合比通用组件更重、但还不应上升为整页的模块。

## Current Areas

- `official/`: 官方发布相关 UI
- `video-editor/`: 视频编辑器局部状态和后续特性收敛点

## Rule Of Thumb

- 需要自己的状态、协议、局部目录结构时，放在 `features/`
- 只是纯展示组件时，不必提升到 `features/`
