# `src/utils/`

本目录放 renderer 轻量工具函数和调试辅助。

## Current Files

- `appDialogs.ts`
- `markdownFrontmatter.ts`
- `pathManager.ts`
- `redclawAuthoring.ts`
- `uiDebug.ts`

## Rules

- 只放无 UI、无复杂宿主依赖的轻量工具。
- 如果工具开始承载协议真相或跨前后端约束，应迁移到 `shared/`。
- 调试工具默认可移除、可关闭，不要影响生产主路径。
