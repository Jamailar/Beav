# `src/config/`

本目录承载 renderer 侧配置映射和来源定义。

## Current File

- `aiSources.ts`: AI 能力来源与配置相关定义

## Rules

- 配置定义只承载映射、常量和轻量解析，不承载页面逻辑。
- 与 host 或 shared 的配置契约冲突时，以更靠近真相源的一层为准，并同步修文档。
