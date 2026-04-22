# `src/runtime/`

本目录负责 renderer 侧的 runtime 事件消费和 session/task 维度的事件分发。

## Entry Point

- [runtimeEventStream.ts](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src/runtime/runtimeEventStream.ts)

## Responsibilities

- 消费统一 `runtime:event`
- 兼容历史 `chat:*`、`creative-chat:*` 事件
- 按 `sessionId`、`taskId`、`runtimeId` 做前端侧过滤

## Rules

- 事件消费层只做解析、归一化、路由，不做页面私有 UI 编排。
- 任何新 runtime 事件，优先先在这里补归一化逻辑，再让页面消费。

## Verification

- 多 session 下事件不串页
- 工具、思考流、完成态都能正确消费
