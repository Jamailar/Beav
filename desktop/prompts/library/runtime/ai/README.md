# `prompts/library/runtime/ai/`

这里存放 AI runtime 的意图路由和子代理编排提示词。

## Current Files

- `route_intent_system.txt`
- `route_intent_user.txt`
- `subagent_orchestrator.txt`

## Rules

- 路由 prompt 负责意图识别和模式选择，不承担执行细节。
- 子代理编排 prompt 只描述编排原则，不复制工具 schema。
