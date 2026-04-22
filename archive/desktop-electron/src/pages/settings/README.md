# `src/pages/settings/`

本目录承载设置页的大块分区和设置页内部共享 UI/类型。

## Current Files

- `SettingsSections.tsx`
- `shared.tsx`

## Characteristics

- 数据域很多，依赖多个 host channel
- 必须允许局部刷新，不能因为单个设置区失败而把整个设置页打空
- 常见区域包括代理、插件、守护进程、MCP、工具诊断、记忆维护等

## Rules

- 设置页说明文字只描述用户可配置项和后果，不写开发实现说明。
- 与宿主状态强绑定的设置项，必须提供默认值和降级显示。

## Verification

- 打开设置页无阻塞
- 单个分区失败不影响其他分区显示
- 保存、刷新、状态轮询行为正确
