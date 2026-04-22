---
doc_type: plan
execution_status: not_started
execution_stage: ready_for_run
last_updated: 2026-04-22
owner: qa-review
target_files:
  - desktop/src-tauri/src/cli_runtime/*
  - desktop/src-tauri/src/commands/cli_runtime.rs
  - desktop/src-tauri/src/tools/app_cli.rs
  - desktop/src/bridge/ipcRenderer.ts
  - desktop/src/runtime/runtimeEventStream.ts
  - desktop/src/pages/Settings.tsx
  - desktop/src/pages/Chat.tsx
  - desktop/src/components/ProcessTimeline.tsx
success_metrics:
  - cli_runtime_host_contract_smoke_pass_rate
  - cli_runtime_renderer_acceptance_pass_rate
  - cli_runtime_event_stream_regression_rate
  - cli_runtime_escalation_decision_accuracy
  - cli_runtime_verification_grounding_rate
---

# CLI Runtime Acceptance And Regression Baseline

Status: Current

## Goal

给即将落地的通用 CLI runtime 提供一套统一验收基线，避免 host、renderer、runtime event、approval、verify 各自为战。

本基线不是零散 checklist，而是单一交付标准：

- host command 必须可验证
- renderer 事件消费必须可回归
- escalation 与 verification 必须有明确成功/失败样例
- 性能退化必须有硬阈值

## Scope

### In Scope

- `desktop/src-tauri/src/cli_runtime/*`
- `desktop/src-tauri/src/commands/cli_runtime.rs`
- `desktop/src-tauri/src/tools/app_cli.rs` 中 `cli_runtime.*` action
- `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src/runtime/runtimeEventStream.ts`
- `desktop/src/pages/Settings.tsx`
- `desktop/src/pages/Chat.tsx`
- `desktop/src/components/ProcessTimeline.tsx`

### Out Of Scope

- `Plugin/`
- `RedBoxweb/`
- `archive/desktop-electron/`
- 与 CLI runtime 无关的视频编辑和稿件业务逻辑

## Entry Points

- 架构蓝图：[generic-cli-runtime-control-plane-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/generic-cli-runtime-control-plane-plan.md)
- 统一事件契约：[contracts/runtime-events.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/contracts/runtime-events.md)
- renderer 事件消费：[src/runtime/runtimeEventStream.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/runtime/runtimeEventStream.ts)
- host runtime 入口：[src-tauri/src/commands/runtime_session.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/runtime_session.rs)
- app tool surface：[src-tauri/src/tools/app_cli.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/app_cli.rs)

## Baseline Strategy

CLI runtime 验收有三种做法：

### Option A

只写手工 checklist。

优点：

- 成本最低
- 不阻塞当前实现

缺点：

- 容易漏掉事件兼容和边界条件
- 每次回归都依赖人肉记忆

### Option B

直接做全量端到端自动化。

优点：

- 理论覆盖最高
- 适合长期回归

缺点：

- 当前桌面端没有现成完整 E2E 基建
- 容易把 QA 任务膨胀成测试平台项目

### Option C

采用混合基线：文档化验收矩阵 + Rust 单元测试 + 页面真机 smoke。

优点：

- 能立即执行
- 和现有 `cargo test`、`pnpm build`、真实页面流一致
- 能覆盖 host、事件流、UI 三个最核心回归面

缺点：

- 仍保留少量人工验证

### Recommended

选择 `Option C`。

理由：

- 这是当前仓库成本最低且最稳的方案。
- host 行为用 Rust 测试锁住，renderer 集成用真实页面 smoke 兜底，不需要先补一整套全新测试平台。

## Test Environment

### Runtime Environment

- macOS 开发机
- Node `>=22 <23`
- `pnpm@10`
- Rust / Cargo 使用仓库当前工具链

### Workspace Fixture

必须准备一个可重复使用的测试工作区，建议放在当前 workspace 内的临时目录，避免外部路径污染：

- `desktop/.tmp/cli-runtime-baseline/fixtures/`
- `desktop/.tmp/cli-runtime-baseline/output/`
- `desktop/.tmp/cli-runtime-baseline/logs/`

### Required Fixture Commands

以下命令覆盖 detect、execute、cancel、verify、escalation 五类关键路径：

1. 检测成功样例

```bash
node --version
python3 --version
pnpm --version
```

2. 检测失败样例

```bash
redconvert-cli-does-not-exist --version
```

3. 无副作用执行样例

```bash
node -e "console.log(JSON.stringify({ ok: true, source: 'cli-runtime-baseline' }))"
```

4. 产物校验样例

```bash
node -e "require('node:fs').writeFileSync('desktop/.tmp/cli-runtime-baseline/output/result.json', JSON.stringify({ ok: true }))"
```

5. 可取消长任务样例

```bash
node -e "let i = 0; setInterval(() => console.log(`tick:${++i}`), 200)"
```

6. 必须触发 escalation 的样例

```bash
curl https://example.com
npm install -g cowsay
node -e "require('node:fs').writeFileSync('/tmp/redbox-cli-runtime-outside.txt', 'x')"
```

## Reuse Vs Build

### Must Reuse

- 统一事件通道：`runtime:event`
- 现有 IPC 桥：`window.ipcRenderer`
- 现有 runtime timeline UI：`ProcessTimeline.tsx`
- 现有确认流和 runtime checkpoint 机制
- 现有 Rust 单元测试框架

### Must Build

- `cli_runtime` 模块级测试用例
- CLI fixture 数据目录
- escalation 决策样例集
- verification rule 样例集
- Settings / Chat / Timeline 的 CLI runtime 验收步骤

### Must Use Existing Libraries

- 交互式命令托管必须使用 `portable-pty`
- JSON 校验必须使用现成 schema 库或现有 Rust 生态能力，不要自写 schema 解释器
- 进程执行和日志流式采集优先沿用 Rust 标准库与现有 runtime event infra

### Should Stay Self-Built

- `cli_runtime` 的 policy rule 归一化
- verification rule 与 execution record 的宿主领域模型
- renderer 对 CLI lifecycle event 的消费映射

## Acceptance Matrix

### A1. Tool Detection

目标：确认 detect 能稳定区分 `Ready`、`Missing`、`Broken`，且结果能回流到 UI。

必须验证：

- `node`、`python3`、`pnpm` 被识别为可用工具
- 不存在命令被标成 `Missing`
- 版本字段、路径字段、最近检查时间有值
- 刷新 detect 时不清空已有工具列表

验收标准：

- 成功检测命令返回结构化记录
- 检测失败不 panic，不阻断其他命令结果
- Settings 的 External Tools 页面在刷新期间保持旧数据

### A2. Environment Lifecycle

目标：确认 `app-global`、`workspace-local`、`task-ephemeral` 生命周期准确。

必须验证：

- 首次访问自动创建 `app-global`
- 指向当前 workspace 时创建 `workspace-local`
- 带 `taskId` 时创建 `task-ephemeral`
- 删除或清理后不会残留错误引用

验收标准：

- environment 记录、path entries、runtime inventory 可读
- workspace 级 environment 不写到错误 workspace
- task 结束后 ephemeral environment 可清理

### A3. Execution Lifecycle

目标：确认命令执行能产生完整 lifecycle，而不是只有一次性的成功/失败结果。

必须验证：

- execute 后产生 execution record
- stdout/stderr 分块写入日志
- 运行中状态可轮询
- cancel 可终止长任务
- 失败命令保留日志和退出码

验收标准：

- `runtime:cli-execution-started`
- `runtime:cli-execution-log`
- `runtime:cli-execution-status`

以上事件必须按顺序可见，且 renderer 不得因为中途切换 session 污染其他会话。

### A4. Escalation Flow

目标：确认高风险命令不会静默放行。

必须验证：

- 网络访问触发 escalation
- workspace 外写入触发 escalation
- 全局安装触发 escalation
- deny 后命令不执行
- approve 后命令按授权范围继续执行

验收标准：

- escalation 理由、权限集合、作用域展示完整
- `only once`、`this session`、`always` 三种授权范围行为正确
- deny 不得留下悬空 running execution

### A5. Verification Flow

目标：确认“退出码 0”不会被误判成“业务成功”。

必须验证：

- `file_exists`
- `output_contains`
- `json_schema`
- `artifact_probe`

至少覆盖以上四类 verifier。

验收标准：

- verify 失败时 execution 保持失败或部分失败状态
- verify 结果进入 timeline 与最终摘要
- verify 失败不得把 task 标成 completed

### A6. Renderer Integration

目标：确认 CLI runtime 接入后，页面仍遵守仓库既有 UX 规则。

必须验证：

- Settings 工具页和环境页可见 CLI 数据
- Chat 中 CLI 生命周期可写入 `ProcessTimeline`
- 页面刷新失败保留旧数据
- 热切换 session 时旧事件不会串屏

验收标准：

- stale-while-revalidate 生效
- 整页 loading 不覆盖已有成功数据
- 日志追加是增量更新，不重置历史块

## Automated Regression Gates

### Gate 0: 每次涉及 CLI runtime 都必须跑

```bash
pnpm -C desktop build
pnpm -C desktop ipc:inventory
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
cargo check --manifest-path desktop/src-tauri/Cargo.toml
```

### Gate 1: host 模块一旦落地，必须补齐并跑通

建议最少包含以下 Rust 测试族：

- `cli_runtime::detector::tests`
- `cli_runtime::policy::tests`
- `cli_runtime::verify::tests`
- `cli_runtime::environment_store::tests`
- `cli_runtime::executor::tests`

最小断言要求：

- detector：成功、缺失、版本解析失败三类
- policy：workspace 外写入、网络、全局安装、`sudo` 四类阻断或升级
- verify：至少覆盖 `file_exists` 与 `json_schema`
- executor：stdout/stderr、exit code、cancel、artifact path 回写
- environment_store：scope 创建和删除

### Gate 2: renderer 事件消费回归

即使没有完整 E2E，也必须验证 `runtimeEventStream` 对新增 CLI 事件的兼容：

- `runtime:cli-install-started`
- `runtime:cli-install-finished`
- `runtime:cli-execution-started`
- `runtime:cli-execution-log`
- `runtime:cli-execution-status`
- `runtime:cli-escalation-requested`
- `runtime:cli-escalation-resolved`
- `runtime:cli-verification-finished`

要求：

- 未知 CLI event 不得导致现有 Chat 流崩溃
- CLI event 必须按 `sessionId` 过滤
- timeline 追加逻辑必须保持增量，不得覆盖已有 tool/history

## Manual Smoke Plan

### M1. Settings Smoke

路径：Settings -> External Tools / Environments

步骤：

1. 打开页面，记录首屏是否立即显示旧数据或空壳。
2. 点击 detect / refresh。
3. 验证旧数据是否仍保留。
4. 检查工具详情、路径、版本、环境信息。

通过标准：

- 页面立即可交互
- 刷新期间不整页清空
- 错误以内联方式展示

### M2. Chat Timeline Smoke

路径：Chat 会话页

步骤：

1. 发起一次 `cli_runtime.execute`。
2. 观察 `ProcessTimeline` 是否依次出现 detect/install/exec/escalation/verify。
3. 切换到另一会话，再切回。
4. 确认旧日志不串到新会话。

通过标准：

- timeline 项顺序正确
- 日志块递增而不是全量抖动
- session 切换后事件过滤正确

### M3. Escalation Smoke

步骤：

1. 执行网络命令或 workspace 外写入命令。
2. 验证弹窗文案是否包含命令目的、权限范围、授权作用域。
3. 先 deny，再 approve。

通过标准：

- deny 不执行
- approve 后能恢复
- 授权状态可在同一 session 内复用或失效，取决于所选 scope

### M4. Verification Smoke

步骤：

1. 执行写入 JSON 文件的命令。
2. 配置 `file_exists` 和 `json_schema` verifier。
3. 先跑成功样例，再故意把 schema 改错。

通过标准：

- 成功时 timeline 显示 verify pass
- 失败时最终摘要明确说明失败原因
- 失败不应被归类为任务成功

## Performance Budget

### P1. Detect Latency

- 热 detect 单工具目标 `< 200ms`
- 4 个常见工具批量 detect 目标 `< 1s`

### P2. Execution Timeline Responsiveness

- 命令启动到 timeline 首条状态出现目标 `< 150ms`
- 长任务日志刷新频率不低于 `500ms` 一次可见更新

### P3. Settings UX

- 热切换回 Settings 不出现整页阻塞
- 已有数据必须先渲染，再后台刷新

### P4. Locking Discipline

必须确认：

- 不在全局锁内做目录扫描
- 不在全局锁内做安装
- 不在全局锁内做日志读取
- 不在全局锁内做 verification I/O

## Regression Hotspots

以下位置最容易回归，改动后必须重点复核：

- `desktop/src/runtime/runtimeEventStream.ts`
- `desktop/src/components/ProcessTimeline.tsx`
- `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src-tauri/src/tools/app_cli.rs`
- `desktop/src-tauri/src/commands/runtime_*`
- `desktop/src-tauri/src/events/*`

## Evidence Requirements

每次相关提交至少要留下以下证据：

- 跑了哪些命令
- 哪些 Rust 测试通过
- 哪个页面做了手工 smoke
- 是否验证了 escalation 和 verify
- 未验证项是什么，为什么没法在本次验证

建议在提交说明或任务回报里使用统一模板：

```md
CLI Runtime Verification Evidence

- Commands:
  - `pnpm -C desktop build`
  - `cargo check --manifest-path desktop/src-tauri/Cargo.toml`
- Automated:
  - `cargo test --manifest-path desktop/src-tauri/Cargo.toml cli_runtime::policy::tests`
- Manual:
  - Settings -> External Tools refresh
  - Chat -> CLI execution timeline
  - Escalation deny/approve
- Not covered:
  - Windows-specific path policy
```

## Recommended Delivery Rule

CLI runtime 相关 PR 未满足以下条件时，不应视为完成：

1. host contract 已跑 Gate 0
2. 新增模块已补对应 Rust 测试
3. Settings 或 Chat 至少走过一次真实 smoke
4. escalation 或 verify 至少验证一条真实链路

## Related Files

- [generic-cli-runtime-control-plane-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/generic-cli-runtime-control-plane-plan.md)
- [development/testing-and-verification.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/development/testing-and-verification.md)
- [contracts/runtime-events.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/contracts/runtime-events.md)
- [runtimeEventStream.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/runtime/runtimeEventStream.ts)
