# `events/` 模块

## 职责

- 统一 runtime 事件发射（`runtime:event`）。
- 提供聊天兼容层事件映射（如 `chat:*` 与 `creative-chat:*`）。
- 管理流式分片与工具调用事件的发送格式。

## 关键点

- 新事件优先走统一 `runtime:event` 协议。
- `chat:*` / `creative-chat:*` 兼容事件只在需要兼容旧前端时保留，且统一从 `events` 模块发射。
