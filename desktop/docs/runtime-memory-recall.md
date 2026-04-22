# Runtime Memory Recall

`Phase 2` 把长期记忆、会话历史和检索证据正式拆开了。

## 三层记忆

当前 memory 统一归一到三类：

- `user_profile`
- `workspace_fact`
- `task_learning`

旧类型会自动归一：

- `preference` -> `user_profile`
- `fact` -> `workspace_fact`
- `general` -> `workspace_fact`

## Recall Contract

新增统一 recall 入口：

- host channel: `runtime:recall`
- runtime tool: `redbox_runtime_control(action=runtime_recall)`
- workspace compatibility: `memory:recall`

支持统一检索：

- `memory`
- `session`
- `checkpoint`
- `tool_result`

并支持：

- `query`
- `sessionId`
- `runtimeId`
- `sources`
- `memoryTypes`
- `includeArchived`
- `includeChildSessions`
- `limit`
- `maxChars`

## Lineage

session 现在会显式返回 lineage：

- `parentSessionId`
- `rootSessionId`
- `forkedFromCheckpointId`
- `resumedFromCheckpointId`
- `compactedCheckpointId`
- `lineagePath`

目前 lineage 写入点：

- `sessions:fork`
- `runtime:fork-session`
- `chat:compact-context`

## Diagnostics

Settings -> Tools -> Developer diagnostics 现在可以直接验证：

- memory 三层计数
- recent session lineage
- runtime recall 命中来源
- recall hit 的 lineage path / checkpoint source

## Prompt Boundary

`Phase 2` 后，structured memory 会作为小型 `memory_summary_section` 进入 system prompt。

历史 transcript / checkpoint / tool result 不再固定注入 prompt，而是通过 `runtime:recall` 按需检索。
