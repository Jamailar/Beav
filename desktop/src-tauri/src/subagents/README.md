# `src-tauri/src/subagents/`

本目录实现子代理的策略、拉起、聚合和类型定义。

## Main Files

- `policy.rs`: 子代理策略
- `spawner.rs`: 子代理拉起
- `aggregation.rs`: 结果聚合
- `types.rs`: 子代理类型

## Rules

- 子代理策略和执行细节分开，避免在 spawner 内塞满调度判断。
- 父子 runtime/task/session 关联字段必须稳定。
- 聚合逻辑必须考虑失败、超时和部分结果。

## Verification

- 至少验证一次子代理启动与完成
- 验证父任务能正确收到聚合结果
