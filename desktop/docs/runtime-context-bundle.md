# Runtime Context Bundle

`Phase 1` 把交互式运行时的 system prompt 装配从“直接拼大字符串”升级成了 section-based `ContextBundle`。

## 入口

- prompt 编排入口：`src-tauri/src/interactive_runtime_shared.rs`
- section 构建：`src-tauri/src/agent/context.rs`
- section 数据结构：`src-tauri/src/agent/context_bundle.rs`
- scan：`src-tauri/src/agent/context_scan.rs`
- budget / truncate：`src-tauri/src/agent/context_budget.rs`

## Section Contract

当前固定 section：

- `identity_section`
- `workspace_rules_section`
- `runtime_mode_section`
- `skill_overlay_section`
- `memory_summary_section`
- `profile_docs_section`
- `tool_contract_section`
- `ephemeral_turn_section`

每个 section 都带：

- `source`
- `priority`
- `charBudget`
- `truncationStrategy`
- `scanWarnings`
- `rawChars`
- `finalChars`
- `truncated`

初版使用固定预算，不开放 UI 自定义，避免过早把 `Phase 1` 变成配置系统。

## 扫描策略

所有外部注入上下文在进入 bundle 前统一经过 scan，当前会检测：

- prompt override
- hidden instruction
- secret / exfiltration pattern
- invisible unicode

scan 结果会写入 section warning，并进入 summary payload。

## 持久化与诊断

每轮 `runtime:query` 会在现有 checkpoint 管线中额外写入一条 `runtime.context_bundle` 记录。

记录最少包含：

- `sessionId`
- `runtimeMode`
- `fingerprint`
- `totalRawChars`
- `totalFinalChars`
- `renderedPromptChars`
- `truncatedSections`
- `scanWarnings`
- `sections[]`

`debug:get-runtime-summary` 会汇总：

- `runtimeWarm.entries[*].contextBundleSummary`
- `runtimeWarm.entries[*].legacySystemPromptChars`
- `runtimeWarm.entries[*].charReductionRatio`
- `latestContextSnapshots`

前端 Settings 的 Tools 诊断面板会展示这些数据，并允许直接检查最近的 `runtime.context_bundle` checkpoint。

## 回退策略

`feature_flags.runtimeContextBundleV2` 控制新装配路径。

- `true`：使用 `ContextBundle`
- `false`：回退到 legacy system prompt 拼接

默认值已切到 `true`。
