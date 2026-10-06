# `src-tauri/src/agent/`

本目录是 agent 执行链的实现层，负责把 query、provider、loop、session、postprocess 等能力串起来。

## Main Files

- `query.rs`: 查询入口
- `engine.rs`: 执行引擎
- `loop.rs`: agent loop
- `provider.rs`: 模型提供商接入
- `session.rs`: 会话相关处理
- `persistence.rs`: agent 相关持久化
- `postprocess.rs`: 后处理
- `wander.rs`: wander 相关 agent 逻辑
- `bridge.rs`: 与宿主/runtime 边界协作

## Rules

- provider 差异不要泄漏到上层页面。
- session 和 persistence 改动要考虑恢复链路。
- query 层只做入口装配，不堆叠所有业务逻辑。

## Verification

- 发起一轮真实 agent 查询
- 验证 provider、session 落盘和后处理结果
