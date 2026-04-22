---
doc_type: plan
execution_status: not_started
execution_stage: ready_for_run
last_updated: 2026-04-22
owner: ai-runtime
scope: desktop
target_files:
  - desktop/src-tauri/src/provider_compat/*
  - desktop/src-tauri/src/runtime/*
  - desktop/src-tauri/src/memory/*
  - desktop/src-tauri/src/commands/chat.rs
  - desktop/src-tauri/src/commands/manuscripts.rs
  - desktop/src-tauri/src/diagnostics.rs
  - desktop/src/bridge/ipcRenderer.ts
  - desktop/src/pages/Settings.tsx
  - desktop/src/pages/settings/SettingsSections.tsx
success_metrics:
  - runtime 底层优化后的关键链路无业务回归
  - runtime query、memory recall、approval、context bundle 无明显性能退化
  - Settings diagnostics 能正确暴露新的 approval/context summary
---

# Runtime Optimization Test Plan

Status: Current

## Goal

验证刚完成的底层优化没有伤到现有业务，并确认新增底层模块本身没有引入明显性能退化。

本计划专门覆盖这次已经落地的优化：

1. `provider_compat` turn policy 收口
2. `runtime contract` / event contract 收口
3. `memory` 独立成子系统
4. `approval runtime` 统一
5. `context bundle` summary 装配
6. Settings diagnostics 暴露新宿主摘要

## Test Objectives

本次测试必须同时回答两个问题：

1. 性能是否退化  
   重点看 runtime query、memory recall、approval 状态更新、Settings diagnostics 汇总。

2. 原有业务是否被打坏  
   重点看 Chat、Manuscripts、Settings、Wander，以及现有兼容事件链。

## Scope

### In Scope

- Tauri host runtime
- renderer bridge / diagnostics 面板
- Chat / runtime query
- Manuscripts script confirm
- Settings developer diagnostics
- memory recall / memory prompt injection

### Out Of Scope

- `Plugin/`
- `RedBoxweb/`
- `archive/desktop-electron/`
- 与本次 runtime 优化无关的视觉样式改动

## Changed Module Map

### Provider Compatibility

- `desktop/src-tauri/src/provider_compat/policy.rs`
- `desktop/src-tauri/src/provider_compat/registry.rs`
- `desktop/src-tauri/src/provider_compat/capabilities.rs`

### Runtime Contracts / Approval / Context

- `desktop/src-tauri/src/runtime/contracts.rs`
- `desktop/src-tauri/src/runtime/approval_runtime.rs`
- `desktop/src-tauri/src/runtime/context_bundle.rs`
- `desktop/src-tauri/src/runtime/types.rs`
- `desktop/src-tauri/src/commands/runtime_query.rs`
- `desktop/src-tauri/src/commands/runtime_session.rs`
- `desktop/src-tauri/src/commands/runtime_session_ops.rs`
- `desktop/src-tauri/src/diagnostics.rs`

### Memory

- `desktop/src-tauri/src/memory/mod.rs`
- `desktop/src-tauri/src/memory/store.rs`
- `desktop/src-tauri/src/memory/recall.rs`
- `desktop/src-tauri/src/memory/prompt.rs`
- `desktop/src-tauri/src/memory/maintenance.rs`
- `desktop/src-tauri/src/commands/workspace_data.rs`

### Business Touchpoints

- `desktop/src-tauri/src/commands/chat.rs`
- `desktop/src-tauri/src/commands/manuscripts.rs`
- `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src/pages/settings/SettingsSections.tsx`

## Test Environment

### Runtime Environment

- macOS 本机开发环境
- Node `>=22 <23`
- `pnpm@10`
- Rust / Cargo 使用当前仓库工具链

### Test Data

准备以下工作区数据：

- 至少 1 个普通 Chat session
- 至少 1 个 `advisor-discussion` 或带 advisor metadata 的 session
- 至少 1 组 memory 数据，包含不同 tags / content
- 至少 1 个 manuscript package，能触发 `manuscripts:update-package-script`
- 至少 1 个 Settings 可见的 runtime warm entry

### Cleanliness Rules

- 不清理用户已有 workspace 数据
- 不修改无关业务文件
- 不在测试中使用 destructive git 命令

## Performance Test Plan

### P1. Runtime Query Latency

目标：确认 `provider turn policy`、`approval runtime`、`context bundle summary` 没有让 `runtime:query` 明显变慢。

执行方式：

1. 打开 Settings -> Tools -> AI Runtime 性能测试。
2. 固定同一条输入，连续跑 5 次 benchmark。
3. 分别在以下模式下执行：
   - `redclaw`
   - `wander`
   - 至少 1 个 advisor-bound session
4. 记录：
   - 总耗时
   - checkpoint 数量
   - tool result 数量
   - `phase0.runtimeQueries.recent`
   - `runtimeWarm.entries[*].contextBundle.finalPromptChars`

验收标准：

- 平均耗时相对本轮优化前历史基线不应退化超过 `15%`
- 如果没有旧基线，则同一环境 5 次运行的 P95 不应比 P50 高出 `30%` 以上
- `context bundle` summary 构建不应导致明显长尾抖动

### P2. Memory Recall Latency

目标：确认 memory 从旧组合逻辑拆成子系统后，检索时间没有异常增加。

执行方式：

1. 运行：

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml recall_matches_rank_content_and_tags -- --nocapture
```

2. 在应用内触发至少 3 次真实 memory recall 场景：
   - 普通 Chat
   - RedClaw / advisor 绑定会话
   - Settings diagnostics 后再回到 Chat
3. 观察 debug log 与最终响应首字时间。

验收标准：

- recall 命中结果正确且顺序稳定
- recall 不应造成可见 UI 卡顿
- recall 失败时，原有 Chat 流程仍可继续，不应整页崩溃

### P3. Approval State Update Cost

目标：确认 `approval runtime` 状态机接入后，confirm 操作不会引入明显卡顿。

执行方式：

1. 连续触发 5 次 `manuscripts:update-package-script`。
2. 分别执行确认与取消。
3. 记录：
   - Settings diagnostics 中 `approvals.pendingCount`
   - `approvals.recent`
   - confirm 到 UI 刷新完成的时间

验收标准：

- approval 进入 pending 的反馈应接近即时，目标 `<= 100ms` 主观可见延迟
- confirm / reject 后，pending 数量与 recent 记录必须一致
- 不允许出现 pending 卡死不消失

### P4. Settings Diagnostics Load Time

目标：确认新增 `approvals` 与 `context bundle` summary 后，Settings diagnostics 没有明显变重。

执行方式：

1. 冷打开 Settings 页面 3 次。
2. 热切换回 Settings 页面 5 次。
3. 记录：
   - 首次可交互时间
   - diagnostics summary 返回时间
   - 页面切换期间是否出现整页阻塞

验收标准：

- 热切换不应出现页面冻结或转圈卡住
- 首次 diagnostics 汇总应在可接受范围内返回，目标 `< 1.5s`
- 已有数据应保持 stale-while-revalidate，不应被整页 loading 覆盖

## Automated Regression Plan

### A1. Provider Policy Regression

运行：

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml qwen_required_tool_choice_turn_policy_disables_thinking -- --nocapture
cargo test --manifest-path desktop/src-tauri/Cargo.toml partial_body_allows_provider_json_fallback -- --nocapture
cargo test --manifest-path desktop/src-tauri/Cargo.toml text_fallback_stays_disabled_after_tool_calls_or_in_wander -- --nocapture
```

通过标准：

- required tool choice 时 thinking policy 行为保持正确
- provider JSON fallback 仍可用
- tool call 后 text fallback 不发生错误回退

### A2. Runtime Contract Regression

运行：

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml runtime_event_envelope_serializes_with_legacy_shape -- --nocapture
cargo test --manifest-path desktop/src-tauri/Cargo.toml approval_payloads_round_trip_with_renderer_shape -- --nocapture
```

通过标准：

- `runtime:event` envelope 字段仍兼容旧 renderer shape
- approval payload 仍能与 renderer 互通

### A3. Memory Subsystem Regression

运行：

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml recall_matches_rank_content_and_tags -- --nocapture
```

通过标准：

- recall ranking 正确
- memory 子系统未破坏现有 recall 逻辑

### A4. Approval Runtime Regression

运行：

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml request_upserts_pending_approval_by_id -- --nocapture
cargo test --manifest-path desktop/src-tauri/Cargo.toml resolve_can_match_by_call_id_or_source_key -- --nocapture
```

通过标准：

- pending approval 能按 id 去重
- resolve 能按 `call_id` 和 `source_key` 命中

### A5. Context Bundle Regression

运行：

```bash
cargo test --manifest-path desktop/src-tauri/Cargo.toml context_bundle_summary_tracks_tool_skill_and_prompt_sizes -- --nocapture
```

通过标准：

- bundle summary 的统计字段正确
- 不因 context summary 引入 prompt 拼装异常

### A6. Renderer Build Regression

运行：

```bash
pnpm --dir desktop build
```

通过标准：

- TypeScript 通过
- renderer 打包通过
- Settings diagnostics 面板相关字段没有类型或构建错误

## Manual Business Regression Plan

### B1. Chat 基本链路

步骤：

1. 新建一个普通 Chat session。
2. 发送不需要工具的普通消息。
3. 再发送一条需要工具或 runtime 检索的消息。
4. 观察：
   - 文本流式输出
   - `runtime:event`
   - tool result
   - done 事件

通过标准：

- 普通回答不受影响
- 工具调用仍能完成并回流结果
- 不出现 session 串线

### B2. Chat Confirm 兼容链路

步骤：

1. 触发一次 `chat:confirm-tool` 或 `ai:confirm-tool`。
2. 分别执行确认和取消。
3. 检查：
   - Chat 页面是否收到正确反馈
   - Settings diagnostics -> approvals recent 是否记录

通过标准：

- confirm/cancel 都能落到统一 approval runtime
- 兼容事件链仍可工作

### B3. Manuscripts Script Confirm

步骤：

1. 打开一个 manuscript package。
2. 调用 `manuscripts:update-package-script` 更新脚本。
3. 观察 script approval 进入 pending。
4. 调用 `manuscripts:confirm-package-script`。
5. 再次读取 package script state。

通过标准：

- 脚本更新后 approval 进入 pending
- confirm 后 approval 从 pending 移出并写入 recent
- 原有 manuscript/package 状态保持正常

### B4. Runtime Query Approval Hold

步骤：

1. 构造一个 `requiresHumanApproval=true` 的 `runtime:query`。
2. 执行 query。
3. 观察返回结果与 diagnostics。

通过标准：

- query 不直接继续执行主链路
- 返回 `pendingApproval`
- Settings diagnostics 可见对应 pending 记录

### B5. Settings Diagnostics

步骤：

1. 打开 Settings -> Tools -> Developer diagnostics。
2. 查看：
   - `phase0`
   - `runtimeWarm`
   - `approvals`
   - `context bundle` 字段

通过标准：

- `approvals.pendingCount` / `resolvedCount` 正确
- `runtimeWarm.entries[*].contextBundle` 字段有值
- 页面不因缺字段而崩溃

### B6. Wander / Advisor Session

步骤：

1. 打开 Wander 或 advisor-bound session。
2. 发起一轮真实 query。
3. 检查：
   - provider policy 是否仍按预期
   - memory / advisor context 是否仍能参与
   - Settings diagnostics 的 `runtimeWarm` 是否可反映 summary

通过标准：

- wander 不因 policy 改造而失效
- advisor 绑定上下文仍能正确加载
- 新 context summary 不破坏旧回答链路

## Failure Criteria

以下任一情况都视为回归：

- Chat 或 Manuscripts 无法完成基础业务链路
- `runtime:query` 在需要 approval 时偷偷继续执行
- Settings diagnostics 打开后页面冻结、崩溃或长时间空白
- memory recall 结果明显错误或丢失
- approval pending / recent 状态不一致
- `runtime:event` 或兼容事件导致前端不再消费

## Evidence Template

每次执行本计划，至少记录以下证据：

### Commands

```text
1. <command>
2. <command>
3. <command>
```

### Manual Flows

- Flow: Chat basic
  - Result:
  - Notes:
- Flow: Manuscripts confirm
  - Result:
  - Notes:
- Flow: Settings diagnostics
  - Result:
  - Notes:

### Performance Snapshot

- Runtime query avg:
- Runtime query p95:
- Settings diagnostics load:
- Approval update visible latency:
- Memory recall subjective latency:

### Regression Verdict

- Pass / Fail:
- Blocking issue:
- Non-blocking issue:

## Recommended Execution Order

1. 先跑自动化聚焦测试，确认基础 contract 没坏。
2. 再跑 `pnpm --dir desktop build`，确认 renderer 没坏。
3. 然后做 Settings diagnostics 验证，先看 summary 是否正常。
4. 最后做 Chat / Manuscripts / Wander 手工业务回归。

原因：

- 先排除底层 contract 和构建问题，避免手工验证被无意义失败打断。
- 先看 diagnostics，再看业务链路，能更快定位是状态机问题还是页面问题。

## Recommendation

这份计划建议分两轮执行：

1. `PR / merge 前`
   - 跑全部自动化聚焦测试
   - 跑一次 `desktop build`
   - 跑最关键的 3 个手工链路：Chat、Manuscripts、Settings

2. `发布前`
   - 补跑 Wander / advisor-bound / background-like approval 场景
   - 采一轮性能数据并与当前版本做对比
