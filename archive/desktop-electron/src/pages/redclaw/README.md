# `src/pages/redclaw/`

本目录是 `RedClaw.tsx` 的页面内子域，承载侧边栏、历史抽屉、常量、辅助函数和类型。

## Current Files

- `RedClawSidebar.tsx`
- `RedClawHistoryDrawer.tsx`
- `config.ts`
- `helpers.ts`
- `types.ts`

## Rules

- 页面专属逻辑先放这里，不要直接下沉到全局 `components/`。
- 文案快捷项、调度模板、默认上下文等稳定规则优先收口到 `config.ts`。
- 如该目录逻辑开始被其他页面复用，再考虑提升到 `features/` 或 `shared/`。

## Verification

- 验证侧边栏交互
- 验证历史抽屉
- 验证模板和默认 prompt 生成
