# `src/pages/`

本目录承载页面级产品表面，是用户能直接导航到的主要界面。

## Current Pages

- `Chat.tsx`
- `Knowledge.tsx`
- `Manuscripts.tsx`
- `RedClaw.tsx`
- `Settings.tsx`
- `MediaLibrary.tsx`
- `CoverStudio.tsx`
- `Subjects.tsx`
- `Wander.tsx`
- 以及其他工作台与辅助页面

## Routing Entry

- 页面挂载入口在 [src/App.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src/App.tsx)
- 顶层导航容器在 `components/Layout.tsx`

## Rules

- 页面只编排本页逻辑，不承载通用 bridge 或全局 runtime 基础设施。
- 页面进入时不能等待慢 IPC 才显示。
- 如页面有局部子域，优先在同目录下放配套文件，例如 `pages/redclaw/`、`pages/settings/`。

## Verification

- 页面切换即时显示
- 进入页面后后台加载数据
- 多次快速切换不会造成旧请求覆盖新状态
