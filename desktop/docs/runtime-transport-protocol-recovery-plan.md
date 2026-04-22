---
doc_type: plan
execution_status: completed
execution_stage: implemented
last_updated: 2026-04-21
owner: codex
target_files:
  - src-tauri/src/main.rs
  - src-tauri/src/agent/provider.rs
  - src-tauri/src/runtime/interactive_recovery.rs
success_metrics:
  - RedClaw/Wander interactive runs survive transient transport failures without losing tool state
  - Provider-specific incompatibilities are decided by capability tables, not scattered conditionals
  - UI receives structured retryable/non-retryable errors instead of prose-assembled conclusions
---

# LexBox 网络传输、协议适配与 Runtime 恢复层优化计划

## 0. 执行结果

本计划已按当前最高风险链路落地，重点不是继续补 transport 特例，而是把 provider 恢复边界收成 typed contract：

- `src-tauri/src/runtime/interactive_recovery.rs`
  - 新增 `RuntimeErrorCategory`
  - 新增 `InteractiveRecoveryContext`
  - 新增 `InteractiveFallbackMode`
  - 让恢复决策从“字符串 if/else”升级为“error envelope + recovery plan”
- `src-tauri/src/agent/provider.rs`
  - 在 provider 入口判断当前 session 是否已经进入 tool loop
  - post-tool 失败时仍优先 interactive retry
  - 禁止带工具上下文的失败直接降级成纯文本 fallback
- `src-tauri/src/main.rs`
  - 新增 `extract_openai_json_assistant_response(...)`
  - 原 fallback 从 `streaming` 改成真正的 `non-streaming JSON completion`
  - 如果 fallback 居然再次返回 `tool_calls`，直接判为恢复失败，不再误当成空文本

这次实现直接解决了当前最痛的错误面：

- 首轮拿到 `tool_calls` 后，第二轮流式 `partial body`
- transport 已经降级到 `http1.1`，但 provider 仍在重复同类 streaming fallback
- agent loop 明明有 tool state，却被错误地拉回文本收尾

当前行为改成：

1. 先按 typed recovery plan 判断错误层级和类别
2. 对可恢复的 `transport/protocol` 错误先做 interactive retry
3. 如果 session 已经进入 tool loop，则严格保留 interactive mode，不允许文本 fallback
4. 只有还没进入 tool loop、且 provider 允许时，才切到 `JSON text fallback`

## 1. 目标

把 LexBox 当前零散耦合在 `curl + provider 兼容分支 + interactive loop` 里的稳定性逻辑，重构成三层清晰边界：

1. `Transport Layer`
2. `Protocol Adapter Layer`
3. `Interactive Recovery Layer`

最终目标不是“少报几个错”，而是让以下链路具备可恢复性：

- 首轮拿到 `tool_calls` 后，第二轮流式中断
- OpenAI-compatible provider 在 `thinking / tool_choice / stream` 组合上存在兼容差异
- fallback 再次拿到 `tool_calls` 时，host 能继续执行，而不是误判成空文本
- 执行型任务必须完成“读素材 / 读档案 / 保存稿件”等契约动作后才能结束

## 2. 参考 aionrs 的可借鉴结构

### 2.1 Provider 与 Transport 分离

`aionrs` 把 provider 抽象为统一接口 `LlmProvider`，见：

- `/Users/Jam/LocalDev/GitHub/aionrs/crates/aion-providers/src/lib.rs`

核心点：

- `stream(request) -> Receiver<LlmEvent>`
- `ProviderError` 先做 typed 分类，再决定是否可重试
- provider 自己负责把原始 HTTP/SSE 响应转换成统一事件流

这比 LexBox 当前在 `main.rs` 里直接拼请求、读 SSE、解释 tool_calls 更稳。

### 2.2 Provider 能力表显式建模

`aionrs` 用 `ProviderCompat` 做 provider 兼容配置，见：

- `/Users/Jam/LocalDev/GitHub/aionrs/crates/aion-config/src/compat.rs`

核心点：

- `supports_thinking`
- `supports_effort`
- `api_path`
- `merge_assistant_messages`
- `clean_orphan_tool_calls`
- `dedup_tool_results`

这解决的是“provider 差异是配置和能力问题，不是 if/else 散落问题”。

### 2.3 流式协议先归一成统一事件

`aionrs` 的 OpenAI provider 把流式响应归一成：

- `TextDelta`
- `ThinkingDelta`
- `ToolUse`
- `Done`
- `Error`

见：

- `/Users/Jam/LocalDev/GitHub/aionrs/crates/aion-providers/src/openai.rs`
- `/Users/Jam/LocalDev/GitHub/aionrs/crates/aion-types/src/llm.rs`

这让 engine 不再关心原始 SSE 细节，只关心“文本、工具、结束原因、错误”。

### 2.4 Runtime 恢复由 Engine 驱动，不由 fallback 文本路径兜底

`aionrs` 的 `AgentEngine` 在一个循环里消费 `LlmEvent`，当出现 `ToolUse` 时继续走编排与执行，再把结果写回消息历史，见：

- `/Users/Jam/LocalDev/GitHub/aionrs/crates/aion-agent/src/engine.rs`
- `/Users/Jam/LocalDev/GitHub/aionrs/crates/aion-agent/src/orchestration.rs`

这意味着：

- transport 短暂失败后，只要状态还在，就应优先回到 interactive engine
- 不应过早降级到“只期待最终文本”的 fallback

### 2.5 协议层先定义能力与错误，再由 UI 呈现

`aionrs` 的 `ProtocolEvent` 和 `ProtocolSink` 把能力、错误、tool request/result 统一成结构化事件，见：

- `/Users/Jam/LocalDev/GitHub/aionrs/crates/aion-protocol/src/events.rs`
- `/Users/Jam/LocalDev/GitHub/aionrs/crates/aion-agent/src/output/protocol_sink.rs`

这正好对应 LexBox 现在的问题：很多错误和状态还是在 host 里临时拼文案，再交给 UI。

## 3. LexBox 当前问题拆解

### 3.1 网络传输层

当前问题集中在：

- `src-tauri/src/http_utils.rs`
- `src-tauri/src/main.rs`

主要缺陷：

- `curl` 流式与非流式路径能力不一致
- HTTP/2 -> HTTP/1.1 降级逻辑不是统一策略，而是逐条热修
- 错误分类过晚，很多错误在 runtime 层才被字符串匹配
- transport attempt 没有标准化记录，调试依赖日志碎片

### 3.2 协议适配层

当前 OpenAI/Anthropic/Gemini 适配混在 `main.rs`：

- 请求体构造
- tool_choice 策略
- thinking 策略
- SSE 解析
- tool delta 聚合

主要缺陷：

- provider capability 没有单一真相
- Qwen/DashScope 这种 OpenAI-compatible 特例靠运行时条件补丁
- fallback 语义和 primary interactive 语义不一致

### 3.3 Runtime 恢复层

主要缺陷：

- interactive runtime 失败后，provider 直接选择不合适的 fallback 路径
- fallback 如果再次拿到 `tool_calls`，当前 host 无法继续 interactive 执行
- 执行型任务的完成条件此前没有显式契约，只能靠模型“自觉”
- “工具轮中断后能否续跑”没有显式状态机

## 4. 最终推荐方案

推荐方案：**统一改成 `reqwest + typed provider adapter + interactive recovery state machine`**。

这是对 `aionrs` 思路的本地化落地，不机械照搬 crate 边界，但保留其结构优点。

### 4.1 方案对比

#### 方案 A：继续增强 `curl`

优点：

- 变更面最小
- 短期补丁快

缺点：

- transport 和 protocol 继续耦合
- provider 差异仍会散落在 `main.rs`
- fallback / retry / resume 难做成统一状态机

结论：

- 只能作为过渡，不适合作为最终方案

#### 方案 B：Hybrid

做法：

- 非流式保留 `curl`
- 流式改 `reqwest`
- runtime 恢复层单独重构

优点：

- 风险低于全量切换
- 能先解决最痛的流式中断问题

缺点：

- 两套 transport 长期并存
- 错误分类和指标体系仍会双轨

结论：

- 可作为短期迁移桥，但不建议长期保留

#### 方案 C：统一 `reqwest` Provider Stack

做法：

- 统一 transport client
- 统一 provider capability registry
- 统一 event stream
- interactive recovery 独立状态机

优点：

- 架构最清晰
- 与 `aionrs` 的成功经验一致
- 最适合持续迭代 provider compatibility

缺点：

- 一次性改动面最大
- 需要补测试基线

结论：

- **推荐采用**

## 5. 目标架构

### 5.1 Layer 1: Transport Layer

建议新增目录：

- `src-tauri/src/llm_transport/mod.rs`
- `src-tauri/src/llm_transport/client.rs`
- `src-tauri/src/llm_transport/error.rs`
- `src-tauri/src/llm_transport/retry.rs`
- `src-tauri/src/llm_transport/stream.rs`
- `src-tauri/src/llm_transport/metrics.rs`
- `src-tauri/src/llm_transport/vcr.rs`

#### 5.1.1 职责

- 统一 HTTP 请求发送
- 统一 SSE 流读取
- 统一 transport error 分类
- 统一 retry / backoff / downgrade
- 统一 attempt 级观测

#### 5.1.2 必须使用的现成库

- `reqwest`
- `tokio`
- `futures-util`
- `serde_json`
- `thiserror`
- `tracing`

#### 5.1.3 必须自研的部分

- SSE 增量解析器
- host/endpoint 级 HTTP/2 降级记忆策略
- LexBox 专用 attempt telemetry
- cassette/VCR 录制与回放层

说明：

- 这里不建议直接依赖通用 SSE crate 作为主解析器。OpenAI-compatible provider 经常在 SSE 末尾 usage chunk、空行、半包、异常结束上有非标准行为，`aionrs` 也是手写流解析，LexBox 应沿用这个思路。

#### 5.1.4 关键数据结构

```rust
enum TransportErrorKind {
    Connect,
    Timeout,
    PartialBody,
    Http2Framing,
    EmptyReply,
    Status { code: u16 },
    Parse,
    Cancelled,
    Unknown,
}

struct RequestAttemptRecord {
    request_id: String,
    session_id: Option<String>,
    provider_key: String,
    model_name: String,
    endpoint: String,
    transport_mode: TransportMode, // Auto | Http2 | Http11
    attempt_index: u8,
    stream: bool,
    started_at_ms: i64,
    ended_at_ms: i64,
    result: AttemptResult,
}
```

#### 5.1.5 核心策略

- 默认 `Auto`
- 若命中 `PartialBody` / `Http2Framing` / `EmptyReply`，本次请求自动切换 `HTTP/1.1`
- 记录到 host-memory LRU：`(base_url, model family) -> preferred transport`
- 连续 N 次降级成功后，后续同源优先 `HTTP/1.1`
- 连续稳定一段时间再恢复 `Auto`

### 5.2 Layer 2: Protocol Adapter Layer

建议新增目录：

- `src-tauri/src/provider_compat/mod.rs`
- `src-tauri/src/provider_compat/capabilities.rs`
- `src-tauri/src/provider_compat/openai.rs`
- `src-tauri/src/provider_compat/anthropic.rs`
- `src-tauri/src/provider_compat/gemini.rs`
- `src-tauri/src/provider_compat/registry.rs`

#### 5.2.1 职责

- 定义 provider/model/source 的能力表
- 构造 provider 请求体
- 解析 provider 响应块
- 将 provider 特定协议映射为统一事件

#### 5.2.2 必须使用的现成库

- `serde`
- `serde_json`

#### 5.2.3 必须自研的部分

- `ProviderCapabilities`
- `ProviderRequestAdapter`
- `ProviderChunkParser`
- OpenAI-compatible 的变体兼容规则

#### 5.2.4 关键数据结构

```rust
struct ProviderCapabilities {
    provider_family: ProviderFamily, // OpenAICompat | Anthropic | Gemini
    supports_streaming: bool,
    supports_tool_choice_required: bool,
    supports_tool_choice_none: bool,
    supports_thinking: bool,
    supports_reasoning_effort: bool,
    requires_disable_thinking_for_forced_tool_choice: bool,
    supports_usage_trailer: bool,
    supports_parallel_tool_calls: bool,
}

struct ProviderProfile {
    key: String,              // source/model family key
    capabilities: ProviderCapabilities,
    request_policy: ProviderRequestPolicy,
    response_policy: ProviderResponsePolicy,
}
```

#### 5.2.5 LexBox 必须落地的规则

- `tool_choice=required` 是否允许，不由 `main.rs` 字符串判断
- `thinking` 是否允许，不由零散 `qwen/dashscope` 判断
- `stream + tool calls + usage trailer` 是否允许，由 profile 决定
- OpenAI-compatible provider 的额外参数，如 `enable_thinking`，由 profile 注入

#### 5.2.6 推荐做法

以 `default_ai_source_id + base_url + model_name pattern` 解析成 `ProviderProfile`：

- `api.openai.com + gpt-*` -> OpenAIProfile
- `api.ziz.hk/redbox/v1 + qwen*` -> OpenAICompatQwenProfile
- `anthropic` -> AnthropicProfile
- `gemini` -> GeminiProfile

这样后面新增 provider 不需要再去 `main.rs` 打补丁。

### 5.3 Layer 3: Interactive Recovery Layer

建议新增目录：

- `src-tauri/src/runtime/interactive_recovery/mod.rs`
- `src-tauri/src/runtime/interactive_recovery/state.rs`
- `src-tauri/src/runtime/interactive_recovery/policy.rs`
- `src-tauri/src/runtime/interactive_recovery/executor.rs`
- `src-tauri/src/runtime/interactive_recovery/progress.rs`

#### 5.3.1 职责

- 维护 interactive runtime 的显式状态机
- 决定什么时候 transport retry
- 决定什么时候 interactive retry
- 决定什么时候才允许 text-only fallback
- 决定执行契约是否已完成

#### 5.3.2 必须自研的部分

- `InteractiveExecutionContract`
- `InteractiveExecutionProgress`
- `InteractiveRecoveryStateMachine`
- `FallbackPolicy`

#### 5.3.3 状态机定义

```text
Idle
 -> RequestingModel
 -> StreamingModelEvents
 -> ExecutingToolBatch
 -> RequestingNextTurn
 -> Completed

异常分支:
StreamingModelEvents
 -> TransportRetryPending
 -> RequestingModel

StreamingModelEvents / RequestingNextTurn
 -> InteractiveRetryPending
 -> RequestingModel

仅当满足以下条件时，才允许进入 TextFallback:
- 当前没有 pending tool calls
- 当前执行契约已满足，或本轮任务本来就是文本问答
- provider profile 明确允许 text fallback
```

#### 5.3.4 关键规则

- 如果失败发生前已经进入 tool loop，优先 `interactive retry`
- 如果 fallback 再拿到 `tool_calls`，必须回到 interactive engine，不得报“空响应”
- 如果执行契约要求 `read/profile/save`，未满足前不得接受“计划性文本”作为最终答案
- 连续 N 次 interactive retry 后仍失败，才允许结束，并返回结构化失败原因

#### 5.3.5 与现有 RedClaw/Wander 的关系

当前已在热修中引入：

- `requireSourceRead`
- `requireProfileRead`
- `requireSave`
- `saveArtifact`

这套字段应成为 `InteractiveExecutionContract` 的正式输入，而不是留在 `main.rs` 临时判断中。

### 5.4 Layer 4: Structured Runtime Event Contract

建议新增/改造：

- `src-tauri/src/events/runtime_transport.rs`
- `src-tauri/src/events/runtime_error.rs`

#### 5.4.1 职责

- 让 UI 看到结构化 attempt / retry / capability / failure 信息
- 避免 UI 再从字符串里猜错误类型

#### 5.4.2 关键事件

- `runtime:model_attempt`
- `runtime:model_retry`
- `runtime:model_transport_downgraded`
- `runtime:model_capability_adjusted`
- `runtime:interactive_retry`
- `runtime:interactive_fallback`
- `runtime:error`

#### 5.4.3 错误信封

```rust
struct RuntimeErrorEnvelope {
    code: String,
    layer: RuntimeErrorLayer,   // transport | protocol | recovery | tool | persistence
    retryable: bool,
    title: String,
    detail: String,
    provider_key: Option<String>,
    model_name: Option<String>,
    transport_mode: Option<String>,
    http_status: Option<u16>,
    raw: Option<String>,
}
```

UI 只能消费这个 envelope，不再根据 prose 拼接判断。

## 6. 模块落地到 LexBox 的具体改造

### 6.1 `src-tauri/src/http_utils.rs`

现状：

- 既做请求构造，又做部分重试策略

改造后：

- 只保留纯底层 HTTP helper 或逐步下线
- transport policy 迁移到 `llm_transport/*`

必须迁走的职责：

- `should_retry_with_http1_1`
- 流式 `curl` 进程处理
- transport 分类逻辑

### 6.2 `src-tauri/src/main.rs`

现状：

- provider 请求构造、SSE 解析、interactive loop、tool 执行、fallback 全挤在一起

改造后：

- `main.rs` 只负责装配和入口分发
- 以下函数应被拆走：
  - `run_openai_streaming_chat_completion`
  - `run_openai_interactive_chat_runtime`
  - `run_openai_prompted_streaming_fallback`

保留在这里的只应是：

- `tauri command` 路由
- `AppState` 注入
- 顶层事件桥接

### 6.3 `src-tauri/src/agent/provider.rs`

现状：

- 同时承担 provider 选择和 fallback 编排

改造后：

- 只负责：
  - 按 session/source/model 解析 `ProviderProfile`
  - 创建 `InteractiveRunner`
  - 返回结构化 `ChatExchangeResponseStage`

不再直接决定：

- transport fallback
- prompted fallback
- provider 特殊兼容分支

### 6.4 `src/pages/Chat.tsx`

改造点：

- 错误展示只读 `RuntimeErrorEnvelope`
- 增加 attempt/retry 展示槽位
- transport retry 不直接渲染成最终失败

### 6.5 `src/pages/Wander.tsx` 与 `src/utils/redclawAuthoring.ts`

改造点：

- 继续作为 execution contract 的 typed source
- 不能再把“必须保存成 `.redpost`”只写在 prompt 文本里

## 7. 必须使用现成库 vs 必须自研

### 7.1 必须使用现成库

- `reqwest`
  - 连接池、TLS、HTTP/1.1/2、超时控制
- `tokio`
  - async runtime、channel、sleep/backoff
- `futures-util`
  - `StreamExt`
- `serde` / `serde_json`
  - request/response/event 编解码
- `thiserror`
  - typed error
- `tracing`
  - attempt/span/structured log

### 7.2 必须自研

- SSE 增量解析器
- provider capability registry
- request/response adapter
- interactive recovery state machine
- execution contract system
- runtime error envelope
- VCR/cassette record-replay

说明：

- 这些部分是产品语义，不适合外包给通用库
- `aionrs` 在这些点上也基本都是自研边界

## 8. 性能优化策略

### 8.1 连接与请求层

- 复用 `reqwest::Client`，按 `base_url` 建 client pool
- 为每个 provider/source 维护 keep-alive
- 记录 endpoint 级 transport preference，避免反复 HTTP/2 失败

### 8.2 流式解析层

- 按 chunk 增量解析，不等待整个 body
- `ToolCallAccumulator` 只累计必要字段
- usage trailer 独立更新，不重复生成大对象

### 8.3 Runtime 层

- tool result 写入 prompt 前做预算裁剪
- session bundle 仅保存必要 canonical messages
- interactive retry 优先基于 bundle 恢复，不重复从 chat_messages 全量重建

### 8.4 UI 层

- attempt / retry / error 状态局部刷新
- 保持已有内容，避免因为 retry 进入全页 loading

## 9. 测试与验证

### 9.1 单元测试

- provider capability matrix
- request body builder
- SSE parser
- tool delta accumulator
- fallback policy
- execution contract completion

### 9.2 集成测试

必须覆盖：

1. 首轮 `tool_calls` 后第二轮 `curl(18)`，interactive retry 成功继续执行
2. Qwen-compatible provider 在 forced tool turn 自动关闭 thinking
3. fallback 再次拿到 `tool_calls`，不能报空响应
4. 执行型 RedClaw 任务未保存前不能结束
5. HTTP/2 降级成功后同源后续请求优先 HTTP/1.1

### 9.3 VCR 测试

参考：

- `/Users/Jam/LocalDev/GitHub/aionrs/crates/aion-agent/src/vcr.rs`

LexBox 也应引入 cassette 机制，用于：

- 录制真实 provider SSE 交互
- 本地稳定回放重现 transport/protocol 边界问题

## 10. 推荐执行顺序

### 第一步：建能力表

先落 `ProviderProfile + ProviderCapabilities`，把现有散落判断迁进去。

### 第二步：建统一 transport

把流式 OpenAI 请求从 `curl` 迁到 `reqwest`，保留日志与错误分类。

### 第三步：建 interactive recovery

把 `interactive retry -> prompted fallback` 顺序做成显式状态机。

### 第四步：改 UI 错误契约

UI 只消费结构化 envelope，不再自己拼结论。

### 第五步：补 VCR 与回归测试

把当前遇到的三个真实事故做成固定回归用例：

- `curl(16) + tool_choice/thinking`
- `curl(18) + second turn partial file`
- `fallback got tool_calls but empty text`

## 11. 推荐结论

最优解不是继续给 `curl` 和 `main.rs` 打补丁，而是按 `aionrs` 思路把边界重建出来：

- `Transport` 负责“怎么连、怎么重试、怎么降级”
- `Protocol Adapter` 负责“这个 provider 到底支持什么”
- `Interactive Recovery` 负责“中断后下一步该走哪条恢复路径”

LexBox 当前已经通过热修证明这三个层面都在出问题。继续零散修会越来越脆。  
建议直接按本计划重构，并把当前已做的热修视为过渡实现，不再继续向 `main.rs` 里堆兼容逻辑。
