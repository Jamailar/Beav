# Runtime Agent Job V1

`Phase 6` 将原本分散的三条执行链统一到同一个 `AgentJobRunner`：

- `scheduler` 自动触发的 RedClaw job
- `tasks:resume` 手动恢复的 runtime task
- assistant daemon webhook / relay 请求

宿主里沿用了现有的 `redclaw_job_definitions` / `redclaw_job_executions` 存储结构，但语义已经提升为统一 `AgentJob`。

## 目标

统一以下行为：

- enqueue / lease / heartbeat / retry / dead-letter
- fresh session contract
- delivery policy
- hold / retry / recovery
- diagnostics lineage

## Job Definition

统一 definition 仍然持久化在 `redclaw_job_definitions`，关键字段：

- `sourceKind`
  - `scheduled`
  - `long_cycle`
  - `runtime_task`
  - `assistant_daemon`
- `sourceTaskId`
- `runtimeMode`
- `triggerKind`
- `progressionKind`
- `payload.jobContract`

`payload.jobContract` 现在是 Phase 6 的核心统一 contract：

- `attachedSkills`
- `capabilitySet`
- `deliveryPolicy`
- `retryPolicy`
- `checkpointPolicy`
- `resultPolicy`

## Execution Flow

统一 runner 位于：

- [src-tauri/src/scheduler/job_runtime.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/scheduler/job_runtime.rs)

执行流程：

1. `enqueue_*_job_execution(...)` 创建 execution
2. `run_job_queue_once(...)` 统一 claim / lease / heartbeat
3. 按 `sourceKind` 分发到具体执行器
4. 统一写回 `succeeded / held / failed / cancelled / dead_lettered`

当前分发：

- `scheduled` / `long_cycle` -> `execute_redclaw_run(...)`
- `runtime_task` -> `execute_runtime_task_resume_job(...)`
- `assistant_daemon` -> `execute_assistant_daemon_job(...)`

## Hold / Retry / Recovery

新增 `held` 作为标准执行状态。

当前使用场景：

- runtime task reviewer/repair 阶段拒绝时，execution 不再直接当作普通失败，而是进入 `held`

恢复路径：

- `background-tasks:retry` 会基于同一个 definition 创建新 execution
- `retryPolicy` 控制默认采用 `retry_from_start` 或 `retry_from_checkpoint`
- 超过阈值后进入 `dead_lettered`

## Delivery Policy

统一 delivery 不再写死在入口层，而是挂在 job contract 上：

- runtime task
  - 写 artifact
  - 更新 runtime task
  - 追加 work item
  - 刷新 diagnostics
- assistant daemon
  - 生成 reply
  - 可选外部投递（当前为 Feishu）
- RedClaw
  - 写 run artifact
  - 更新 project / automation state

## Diagnostics

当前 diagnostics 面板已经能看到：

- job definitions / executions 计数
- recent agent jobs
- background task lineage
- last checkpoint
- last artifact
- retry / archive / cancel controls

相关入口：

- [src-tauri/src/runtime/phase0.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/runtime/phase0.rs)
- [src/pages/settings/SettingsSections.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/pages/settings/SettingsSections.tsx)

## Feature Flag And Rollback

统一 job runner 受以下开关控制：

- `feature_flags.runtimeAgentJobV1`

当前默认开启，但仍保留回退路径：

- `tasks:resume` 可退回 legacy 直接执行
- assistant daemon 可退回 legacy direct turn path

## Smoke

`Phase 0` smoke 现在包含 `agent-job-preflight`：

- 创建临时 runtime task
- 生成 runtime task job definition
- 入队 execution
- 清理临时记录

这条 smoke 用来验证：

- definition contract 可生成
- unified enqueue path 可用
- rollback 不依赖真实模型请求
