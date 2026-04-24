# `src/config/`

本目录承载 renderer 侧配置映射和来源定义。

## Current File

- `aiSources.ts`: AI 能力来源与配置相关定义
- `startupAnnouncements.ts`: 版本化启动/更新弹窗配置

## Rules

- 配置定义只承载映射、常量和轻量解析，不承载页面逻辑。
- 与 host 或 shared 的配置契约冲突时，以更靠近真相源的一层为准，并同步修文档。
- 版本化弹窗配置应保持短小：标题、摘要、最多 3 条亮点、少量快捷入口，复杂交互留在组件层。
