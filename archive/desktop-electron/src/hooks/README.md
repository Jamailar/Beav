# `src/hooks/`

本目录放 renderer 可复用行为型 hook。

## Current Files

- `useFeatureFlags.ts`
- `useOfficialAuthLifecycle.ts`
- `usePageRefresh.ts`

## Rules

- hook 负责复用行为，不负责定义产品结构。
- 涉及页面刷新时，必须遵守 stale-while-revalidate。
- 涉及宿主监听时，必须处理清理和重复订阅问题。
