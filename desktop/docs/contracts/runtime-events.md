# Runtime Events Contract

Status: Current

## Scope

覆盖统一 `runtime:event` 包络和 renderer 兼容消费层，不覆盖所有历史 `chat:*` 事件的完整细节。

## Source Of Truth

- [src-tauri/src/events/README.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/events/README.md)
- [src-tauri/src/runtime/contracts.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/runtime/contracts.rs)
- [src/runtime/runtimeEventStream.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/runtime/runtimeEventStream.ts)

## Envelope Shape

统一事件至少包含：

- `eventType`
- `sessionId`
- `taskId`
- `runtimeId`
- `parentRuntimeId`
- `payload`
- `timestamp`

## Main Event Types

- `runtime:stream-start`
- `runtime:text-delta`
- `runtime:done`
- `runtime:tool-start`
- `runtime:tool-update`
- `runtime:tool-end`
- `runtime:task-node-changed`
- `runtime:subagent-started`
- `runtime:subagent-finished`
- `runtime:checkpoint`

## Consumption Rules

- renderer 必须按 `sessionId` 过滤非当前会话事件
- task 相关 UI 再按 `taskId` 细分
- 事件 payload 可能部分缺失，消费端必须容错
- 新能力优先挂在统一 `runtime:event`，历史 `chat:*` 仅做兼容

## Verification

- 发起一次真实 runtime 会话
- 确认 `thinking`、文本流、工具调用、完成事件都可达
- 快速切换 session 时，旧事件不会污染当前页面
