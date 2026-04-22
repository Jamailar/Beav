# `src/features/official/`

本目录承载官方发布或官方账号能力相关的前端模块。

## Current Files

- `generatedOfficialAiPanel.tsx`: 官方 AI 面板
- `index.ts`: 对外导出和类型入口

## Characteristics

- 状态复杂
- 与登录态、积分、模型列表、调用记录等宿主数据绑定较深
- 必须遵守 stale-while-revalidate，不能因为刷新把整个面板清空

## Verification

- 验证登录态展示
- 验证刷新、二维码/短信链路
- 验证失败时仍保留最后一次可展示状态
