---
doc_type: plan
execution_status: not_started
last_updated: 2026-05-12
---

# LLM 可用性登录锁改造计划

## 目标

把当前“必须登录官方账号才能进入 App”的硬门禁，改造成“系统必须存在一个可用 LLM 才能进入 App”。

用户可以通过两条路径解锁：

1. 官方账号登录：继续使用 Thrive / RedBox 官方账号、官方模型、积分、支付、官方 API key 自动托管。
2. 自定义 LLM 源：在登录页输入 API Base URL 和 API Key，自动检测协议、拉取模型列表、选择默认聊天模型，保存为默认 AI 源，然后进入 App。

核心原则：登录锁不再等同于官方账号锁，而是 LLM readiness lock。官方账号只是其中一种 LLM provider。

## 当前架构判断

### 当前门禁

当前 App 顶层在 `desktop/src/App.tsx` 中通过 `useOfficialAuthLifecycle` 和 `useOfficialAuthState` 控制进入条件。

现状逻辑：

```text
App start
  -> bootstrap official auth
  -> auth status restoring/refreshing: show checking gate
  -> !officialAuthLoggedIn: show official login gate
  -> officialAuthLoggedIn: enter AuthenticatedApp
```

问题：即使用户已经在 Settings 里配置了自定义 `api_endpoint/api_key/model_name` 或 `ai_sources_json/default_ai_source_id`，只要没有官方登录，仍然会被挡在登录页。

### 当前可复用能力

现有能力已经覆盖自定义模型源的大部分底层需求：

- `desktop/src/pages/Settings.tsx` 已有 AI 源管理、模型列表拉取、默认模型保存、route 配置保存。
- `desktop/src/config/aiSources.ts` 已有 provider preset、协议类型、默认源结构。
- `desktop/src/pages/settings/shared.tsx` 已有 `parseAiSources`、`normalizeSourceModels`、`normalizeAiModelDescriptors`、`toAiModelDescriptor`、`generateAiSourceId` 等工具。
- `desktop/src-tauri/src/commands/skills_ai.rs` 已有 `ai:detect-protocol`、`ai:fetch-models`、`ai:test-connection`。
- `desktop/src-tauri/src/official_support.rs` 已有 OpenAI / Anthropic / Gemini 模型列表拉取实现。
- `desktop/src-tauri/src/runtime/config_runtime.rs` 已有按 `ai_model_routes_json`、`default_ai_source_id`、`ai_sources_json` 解析 chat runtime config 的能力。
- `desktop/src-tauri/src/commands/system.rs` 的 `db:get-settings` 已通过 `project_settings_for_runtime` 合并官方 auth runtime，`db:save-settings` 已能持久化 AI 源设置并刷新 runtime warm state。

### 当前不适合继续复用为门禁的点

`AuthStatus` 和 `AuthStateSnapshot.loggedIn` 语义是官方账号登录状态，不应该被扩展为“自定义 key 也算 loggedIn”。否则会污染支付、积分、官方模型、官方 API key、会话 refresh 等路径。

必须新增一个独立的 LLM readiness 状态，避免把账号身份认证和模型可用性混在一起。

## 推荐方案

推荐采用“新增 LLM Readiness 层 + 登录页双模式”的方案。

```text
Official Auth Runtime     Custom AI Source Settings
        |                          |
        |                          |
        v                          v
          LLM Readiness Resolver
                    |
                    v
              App Entry Gate
                    |
          ready -> AuthenticatedApp
          not ready -> LLM Setup Gate
```

这样官方账号仍然保持自己的 auth 生命周期，自定义模型源只负责满足 LLM 可用性，不伪装成官方登录。

## 方案对比

| 方案 | 做法 | 优点 | 风险 | 结论 |
| --- | --- | --- | --- | --- |
| A. 把自定义 key 也写进 `AuthStateSnapshot.loggedIn` | 让官方 auth hook 返回 loggedIn=true | 改动少 | 语义污染严重，支付/积分/官方账号 UI 会误判；后续 401 仍可能触发官方 reauth | 不推荐 |
| B. 在 App.tsx 里直接读 settings 判断有没有自定义 key | 前端临时绕过官方登录 | 改动较小 | readiness 逻辑散落前端；无法统一校验模型是否真的可用；启动竞态多 | 不推荐 |
| C. 新增 LLM readiness runtime / IPC | 后端统一解析 official + custom 是否可用，前端只消费 readiness | 语义清晰；可测试；后续支持本地模型、免费用户、离线模型更稳 | 初次改动稍大 | 推荐 |

## 目标用户流程

### 官方登录路径

```text
打开 App
  -> LLM gate 检查 official auth
  -> 如果官方账号已登录且官方 AI key/模型可用
  -> 进入工作台
```

若官方账号未登录：

```text
登录页
  -> 选择“官方账号”
  -> 手机号/微信登录
  -> bootstrap official auth
  -> ensure official API key
  -> sync official model source
  -> LLM readiness 变为 ready
  -> 进入工作台
```

### 自定义 LLM 路径

```text
登录页
  -> 选择“自定义 API”
  -> 输入 Base URL + API Key
  -> 点击继续
  -> detect protocol
  -> fetch models
  -> 自动选择默认 chat 模型
  -> 保存 ai_sources_json/default_ai_source_id/api_endpoint/api_key/model_name/ai_model_routes_json
  -> LLM readiness 变为 ready
  -> 进入工作台
```

### 本地模型路径

本地 OpenAI-compatible endpoint 可以允许空 key，例如 Ollama / LM Studio。

```text
登录页
  -> 选择“自定义 API”
  -> 输入 http://127.0.0.1:11434/v1
  -> API Key 留空
  -> fetch models
  -> 保存为本地 AI 源
  -> 进入工作台
```

判断依据复用 Settings 里的本地源判断规则，但实现应抽到共享工具，避免复制。

## 模块设计

## 1. 后端新增 LLM Readiness 模块

建议新增文件：

- `desktop/src-tauri/src/llm_readiness.rs`
- 或 `desktop/src-tauri/src/commands/llm_readiness.rs`

建议暴露 IPC channel：

- `llm-readiness:get-state`
- `llm-readiness:configure-custom-source`
- `llm-readiness:refresh`

### `llm-readiness:get-state`

输入：无。

输出：

```json
{
  "ready": true,
  "mode": "official | custom | local | none",
  "sourceId": "redbox_official_auto | ai-source-...",
  "sourceName": "OpenAI",
  "baseURL": "https://api.openai.com/v1",
  "model": "gpt-4.1",
  "protocol": "openai",
  "reason": "ready | missing_source | missing_base_url | missing_api_key | missing_model | official_auth_required | fetch_failed",
  "officialLoggedIn": false,
  "canUseOfficial": false,
  "canUseCustom": true,
  "updatedAt": "2026-05-12T..."
}
```

### Readiness 判定规则

后端读取 projected settings：

```text
store.settings + auth_runtime projected session
```

判定优先级：

1. 如果默认 route/chat 指向官方源：
   - 必须 official auth logged in。
   - 必须 `official_ai_api_key_from_settings(settings)` 有明文 key。
   - 必须能解析出默认 chat model。模型可来自 `ai_model_routes_json.chat.model`、官方模型缓存或 official source model。
2. 如果默认 route/chat 指向自定义源：
   - 必须有 baseURL。
   - 非本地源必须有 apiKey。
   - 必须有 model。
   - protocol 必须可推断为 `openai | anthropic | gemini`。
3. 如果没有 route，但 legacy `api_endpoint/api_key/model_name` 存在：
   - 视为 custom legacy ready，并建议在 refresh 时迁移成 `ai_sources_json`。
4. 如果都不存在：
   - `ready=false, mode=none, reason=missing_source`。

### 为什么后端判定

- App 启动时门禁必须稳定，不能依赖 Settings 页面组件状态。
- 运行时使用的是 Rust 侧 settings，前端只看 local state 会出现“UI 已保存但 runtime 未刷新”的竞态。
- 后端能复用 `resolve_chat_config`，与真实 AI 请求路径保持一致。

## 2. 后端新增自定义源配置 action

`llm-readiness:configure-custom-source`

输入：

```json
{
  "baseURL": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "presetId": "openai",
  "protocol": "openai",
  "preferredModel": ""
}
```

处理流程：

```text
validate input
  -> normalize baseURL
  -> infer protocol
  -> allow empty key only when local endpoint
  -> fetch models by protocol
  -> filter chat-capable models where possible
  -> pick default model
  -> build AiSourceConfig
  -> merge into ai_sources_json
  -> set default_ai_source_id
  -> update ai_model_routes_json.chat/wander/team/knowledge/redclaw to custom source
  -> update legacy api_endpoint/api_key/model_name for compatibility
  -> persist settings
  -> refresh runtime warm state
  -> emit settings:updated
  -> emit llm-readiness:state-changed
```

输出：

```json
{
  "success": true,
  "source": {
    "id": "ai-source-...",
    "name": "OpenAI",
    "presetId": "openai",
    "baseURL": "https://api.openai.com/v1",
    "model": "gpt-4.1",
    "protocol": "openai"
  },
  "models": [
    { "id": "gpt-4.1", "capabilities": ["chat"] }
  ],
  "readiness": { "ready": true, "mode": "custom" }
}
```

### 默认模型选择策略

按顺序选择：

1. 用户传入的 `preferredModel` 且存在于列表中。
2. 模型 capability 包含 `chat` 的第一个。
3. 常见优先模型名命中：`gpt-4.1`、`gpt-4o`、`claude-3-5-sonnet`、`gemini-1.5-pro`、`deepseek-chat`、`qwen-plus`。
4. 远端返回列表中的第一个模型。
5. 如果模型列表为空，则失败，不保存。

登录页需求是“自动拉取模型列表，设置一个默认 LLM 模型”，所以不建议在第一版让用户手动选择模型。可以在高级折叠里允许修改，但默认路径应一键完成。

## 3. 前端新增 `useLlmReadinessState`

建议新增：

- `desktop/src/hooks/useLlmReadinessState.ts`
- `desktop/src/hooks/useLlmReadinessLifecycle.ts`

`useLlmReadinessState` 负责：

- 初次调用 `llm-readiness:get-state`。
- 监听 `llm-readiness:state-changed` 和 `settings:updated`。
- 输出 `{ snapshot, bootstrapped }`。

`useLlmReadinessLifecycle` 负责：

- App 启动时刷新 readiness。
- 窗口 focus / visible 时节流刷新。
- 不主动触发官方登录，只触发 readiness 重新判断。

注意：官方 auth lifecycle 仍需保留，但不应该阻塞自定义源用户进入 App。

## 4. 改造 App 顶层门禁

当前：

```text
App -> officialAuthPending -> OfficialLoginGate checking
App -> !officialAuthLoggedIn -> OfficialLoginGate login
App -> AuthenticatedApp
```

目标：

```text
App -> llmReadinessPending -> LlmSetupGate checking
App -> !llmReadiness.ready -> LlmSetupGate setup
App -> AuthenticatedApp
```

官方 auth 状态只作为 `LlmSetupGate` 的一个输入。

伪代码：

```tsx
function App() {
  useOfficialAuthLifecycle();
  useLlmReadinessLifecycle();

  const officialAuth = useOfficialAuthState();
  const llmReadiness = useLlmReadinessState();

  if (!llmReadiness.bootstrapped) {
    return <LlmSetupGate mode="checking" officialAuth={officialAuth.snapshot} />;
  }

  if (!llmReadiness.snapshot?.ready) {
    return <LlmSetupGate mode="setup" officialAuth={officialAuth.snapshot} />;
  }

  return <AuthenticatedApp />;
}
```

## 5. 登录页 UI 改造

建议把 `OfficialLoginGate` 改名或拆分为：

- `LlmSetupGate`
- `OfficialLoginPanel`
- `CustomApiSetupPanel`

UI 要保持克制，不要堆说明文字。

建议布局：

```text
Welcome back
Choose how Thrive should run AI.

[ 官方账号 ] [ 自定义 API ]

官方账号 tab:
  existing sms/wechat login

自定义 API tab:
  Provider preset select
  Base URL
  API Key
  Continue
  inline status: 正在拉取模型 / 已选择 xxx / 错误原因
```

默认 tab 选择规则：

- 如果 `officialAuthStatus === reauthRequired`，默认官方账号 tab。
- 如果 settings 里存在未完成自定义源，默认自定义 API tab。
- 如果 App variant 是 Thrive 且国内 realm，默认官方账号 tab。
- 用户手动切换后用 local state 保持。

### 自定义 API 表单行为

输入项：

- Preset：默认 `OpenAI Compatible` 或 `Custom`。
- Base URL：必填。
- API Key：远端必填，本地 endpoint 可空。
- 按钮：`继续`。

点击继续：

```text
set busy
clear error
call llm-readiness:configure-custom-source
if success: refresh readiness and enter app
if error: show short inline error
```

不要在登录页暴露模型 route、embedding、image、voice 等高级设置。

## 6. Settings 页面联动

Settings 已经有 AI 源管理。新增登录页配置后，Settings 需要自然展示这个源。

改动点：

1. `parseAiSources` 能正常读取新源。
2. `default_ai_source_id` 指向新源。
3. `ai_model_routes_json.chat/wander/team/knowledge/redclaw` 默认为 custom，新用户进入后聊天、RedClaw、知识库文本能力都能用。
4. 其它高级能力保持现有默认：
   - transcription/embedding/image/visualIndex/videoAnalysis 不强行切到自定义源，除非模型能力明确支持。
   - voiceTts/voiceClone 仍是官方-only，需要官方登录；自定义免费用户看不到或看到不可用状态。

### 为什么不把所有 route 都切到自定义源

自定义 API 只保证 LLM chat 可用，不保证：

- embedding
- transcription
- image generation
- video analysis
- TTS / voice clone

如果登录页一键把所有能力都切过去，会制造更多运行时失败。第一版只保证核心 Agent / Chat / RedClaw 文本能力。

## 7. Runtime 影响

### Chat / RedClaw / Team

现有 `resolve_chat_config` 已支持 route config，因此只要保存正确：

```json
{
  "chat": { "mode": "custom", "sourceId": "...", "model": "..." },
  "wander": { "mode": "custom", "sourceId": "...", "model": "..." },
  "team": { "mode": "custom", "sourceId": "...", "model": "..." },
  "knowledge": { "mode": "custom", "sourceId": "...", "model": "..." },
  "redclaw": { "mode": "custom", "sourceId": "...", "model": "..." }
}
```

这些路径可以直接使用自定义源。

### 官方-only 功能

必须保留官方账号依赖：

- 积分展示
- 官方支付
- 官方 API key 管理
- 官方模型列表面板
- 官方视频生成
- 官方语音克隆
- 任何官方账号资料接口

这些功能的入口不能因为 `llmReadiness.ready === true` 就认为已登录。

UI 上要区分：

```text
App is usable because LLM is configured.
Official account features require login.
```

## 8. 数据结构和持久化

### AI 源保存格式

继续使用现有 `ai_sources_json`，不要新增一套 provider store。

示例：

```json
[
  {
    "id": "ai-source-1778580000000",
    "name": "OpenAI",
    "presetId": "openai",
    "baseURL": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "models": ["gpt-4.1"],
    "modelsMeta": [
      { "id": "gpt-4.1", "capabilities": ["chat"] }
    ],
    "model": "gpt-4.1",
    "protocol": "openai"
  }
]
```

### 兼容 legacy 字段

必须同步写：

- `api_endpoint`
- `api_key`
- `model_name`

原因：仍有一些旧路径和 fallback 读这些字段。

### Route 保存格式

必须同步写：

- `ai_model_routes_json`
- `default_ai_source_id`

默认 route：

```json
{
  "chat": { "mode": "custom", "sourceId": "ai-source-...", "model": "gpt-4.1" },
  "wander": { "mode": "custom", "sourceId": "ai-source-...", "model": "gpt-4.1" },
  "team": { "mode": "custom", "sourceId": "ai-source-...", "model": "gpt-4.1" },
  "knowledge": { "mode": "custom", "sourceId": "ai-source-...", "model": "gpt-4.1" },
  "redclaw": { "mode": "custom", "sourceId": "ai-source-...", "model": "gpt-4.1" },
  "transcription": { "mode": "disabled", "sourceId": "", "model": "" },
  "embedding": { "mode": "disabled", "sourceId": "", "model": "" },
  "image": { "mode": "disabled", "sourceId": "", "model": "" },
  "visualIndex": { "mode": "disabled", "sourceId": "", "model": "" },
  "videoAnalysis": { "mode": "disabled", "sourceId": "", "model": "" },
  "voiceTts": { "mode": "official", "sourceId": "redbox_official_auto", "model": "speech-2.8-turbo" },
  "voiceClone": { "mode": "official", "sourceId": "redbox_official_auto", "model": "minimax-voice-clone" }
}
```

如果不想 disabled transcription/embedding，也可以保持现有默认 official，但 UI 必须能承受“未登录官方账号时这些功能不可用”。推荐第一版只改 chat-family route，不主动改高级 route。

## 9. 安全边界

### API Key 存储

现有 `api_key` 和 `ai_sources_json[].apiKey` 已经保存明文。这个计划不改变安全等级。

但必须避免：

- 登录页错误日志打印 API key。
- `llm-readiness:get-state` 返回 API key。
- debug trace 输出 Authorization header。
- 前端状态 changed event 携带 key。

### 官方账号和自定义源隔离

不要把自定义 API key 写入：

- `redbox_auth_session_json`
- `redbox_auth_api_keys_json`
- official source `redbox_official_auto`
- official auth runtime secrets

不要把官方 API key 写入自定义源。

## 10. 必须用现成库的部分

必须复用现有库/工具：

- HTTP 调用：继续复用 `run_curl_json` / `run_curl_json_response`，保持代理、日志脱敏、错误格式一致。
- 模型拉取：复用 `fetch_models_by_protocol`、`fetch_openai_models`、`fetch_anthropic_models`、`fetch_gemini_models`。
- 协议推断：复用 `infer_protocol`。
- Tauri IPC：复用现有 `ipc_invoke` channel 分发机制。
- React UI 组件：复用 Settings 里的 `AiPresetSelect`、`PasswordInput`、模型源 normalization 工具。

## 11. 需要自研的部分

必须自研：

- `LlmReadinessSnapshot` 状态模型。
- `resolve_llm_readiness(settings, auth_runtime)` 判定函数。
- `configure_custom_llm_source(payload)` 原子保存流程。
- 登录页双模式 gate UI。
- readiness lifecycle hook。
- 官方 auth 与 LLM readiness 的状态事件桥接。

原因：这些是产品语义，不是第三方库能解决的问题。

## 12. 边界条件清单

### 启动边界

- 有官方登录但官方 API key 缺明文：readiness 不应直接 ready，应触发官方 bootstrap 修复，修复失败则允许用户切自定义源。
- 有自定义源但模型为空：readiness false，登录页显示自定义 API tab，并允许重新拉取模型。
- 有 legacy `api_endpoint/api_key/model_name` 但没有 `ai_sources_json`：readiness true，同时后台可迁移成 source。
- 本地 endpoint 空 key：允许。
- 远端 endpoint 空 key：拒绝。

### 请求边界

- 自定义源 401：不能触发官方 reauth，也不能跳官方登录页；应显示 provider auth error。
- 官方源 401：可以触发官方 refresh / reauth。
- 切换默认源后：runtime warm state 必须刷新。

### UI 边界

- 自定义源用户进入 App 后，Settings 的官方账号区域应显示“未登录”，但不能把用户赶回登录页。
- 退出官方账号不能清除自定义源，除非用户手动删除。
- 删除唯一可用自定义源后，如果没有官方可用 LLM，应回到 LLM setup gate。
- 登录页不显示冗长解释，不暴露高级 route。

### 数据边界

- `db:get-settings` 返回 projected official settings，但 readiness 不能因此把官方 redacted key 当可用 key。
- `sanitize_store_for_persist` 不能误删自定义 key。
- `clear_official_auth_state` 不能清空 custom source。

## 13. 性能策略

### 启动性能

- `llm-readiness:get-state` 只做本地 settings/runtime 解析，不发网络请求。
- 网络模型拉取只在用户点击自定义 API 继续时发生。
- focus/visible 只 refresh readiness 状态，不重复 fetch models。

### 网络性能

- `configure-custom-source` 拉模型时最多一次 protocol detect + 一次 fetch models。
- OpenAI-compatible endpoint candidate 当前会尝试多个 `/models` 路径，保留现有逻辑，但前端显示一个整体 loading，不显示多段过程。
- 可以加 15 秒超时，沿用现有 HTTP timeout。

### 状态性能

- 保存 settings 时持锁只做内存 merge。
- 拉模型、协议探测等网络 I/O 不在 store lock 内执行。
- 最终 settings patch 再持锁写入。

## 14. 实施步骤

### Commit 1: 新增 LLM readiness 后端状态与 IPC

改动：

- 新增 `desktop/src-tauri/src/llm_readiness.rs`。
- 在 `main.rs` 注册模块。
- 在 IPC 分发里接入：
  - `llm-readiness:get-state`
  - `llm-readiness:refresh`
- 实现纯本地 `resolve_llm_readiness`。
- 不改 UI。

验收：

- 官方登录时返回 ready official。
- 自定义 legacy settings 时返回 ready custom。
- 空 settings 时返回 missing_source。

### Commit 2: 新增自定义源配置 IPC

改动：

- 实现 `llm-readiness:configure-custom-source`。
- 复用 `infer_protocol` 和 `fetch_models_by_protocol`。
- 保存 `ai_sources_json/default_ai_source_id/api_endpoint/api_key/model_name/ai_model_routes_json`。
- 触发 `settings:updated` 和 `llm-readiness:state-changed`。

验收：

- OpenAI-compatible provider 能拉模型并保存默认模型。
- 本地 Ollama endpoint 允许空 key。
- 远端空 key 拒绝。

### Commit 3: 前端 hook 与 bridge 类型

改动：

- `desktop/src/bridge/ipcRenderer.ts` 增加 `llmReadiness` namespace。
- `desktop/src/types.d.ts` 增加类型。
- 新增 `useLlmReadinessState`。
- 新增 `useLlmReadinessLifecycle`。

验收：

- hook 能在 App 启动拿到 readiness。
- settings 更新后 readiness 会刷新。

### Commit 4: 改造 App 顶层门禁

改动：

- `App.tsx` 从 official auth gate 改成 LLM readiness gate。
- 官方 auth lifecycle 保留，但不再单独决定能否进入 App。
- 保留 onboarding 行为。

验收：

- 官方账号登录用户照常进入。
- 已配置自定义源但未官方登录用户能进入。
- 无任何 LLM 配置用户停留 setup gate。

### Commit 5: 登录页增加自定义 API 模式

改动：

- 拆分 `OfficialLoginGate` 为 `LlmSetupGate` / `OfficialLoginPanel` / `CustomApiSetupPanel`。
- 自定义 API tab 调用 `llm-readiness:configure-custom-source`。
- 成功后刷新 readiness。

验收：

- 输入 URL/key 后自动拉模型、选默认模型、保存并进入 App。
- 错误仅以内联短文案显示。
- UI 不增加复杂说明。

### Commit 6: Settings 和官方-only 功能收口

改动：

- Settings 中官方 route 按钮继续受 `officialAuthLoggedIn` 控制。
- 自定义源用户进入 App 后，官方支付/积分/API key 管理显示登录提示而不是全局登出。
- 删除最后一个可用 LLM 源时触发 readiness false。

验收：

- 自定义源不污染官方账号状态。
- 官方登出不清空自定义源。
- 自定义源删除后回到 setup gate。

## 15. 测试计划

### Rust 单元测试

新增覆盖：

- `resolve_llm_readiness_empty_settings_is_not_ready`
- `resolve_llm_readiness_custom_source_ready`
- `resolve_llm_readiness_local_source_allows_empty_key`
- `resolve_llm_readiness_remote_source_requires_key`
- `resolve_llm_readiness_official_requires_plaintext_key`
- `configure_custom_source_saves_routes_and_legacy_fields`

### 手动验证矩阵

| 场景 | 预期 |
| --- | --- |
| 首次安装，无官方登录，无自定义源 | 显示 LLM setup gate |
| 官方登录成功 | 进入 App |
| 官方登录失效但已有自定义源 | 仍进入 App，官方功能提示登录 |
| 输入 OpenAI-compatible URL/key | 拉模型，保存默认模型，进入 App |
| 输入本地 Ollama URL 且 key 空 | 拉模型，进入 App |
| 输入远端 URL 但 key 空 | 不保存，显示 API Key 缺失 |
| 自定义源 key 错误 | 不进入 App，显示拉模型失败 |
| 删除唯一自定义源且未官方登录 | 回到 setup gate |
| 官方登出 | 不删除自定义源，不影响进入 App |

## 16. 风险点

1. `AuthStateSnapshot.loggedIn` 不能改语义，否则会污染官方账号功能。
2. `ai_sources_json` 里的官方源是虚拟/托管源，自定义保存逻辑不能覆盖它。
3. `resolve_chat_config` 当前有 official fallback，需要确保 custom route 不被 official baseURL 判断误伤。
4. 自定义 provider 只保证 chat，不保证 embedding/image/video/voice。
5. 登录页配置保存必须一次性写完整 route，否则进入 App 后聊天可能仍找官方源。
6. 删除/切换源后 readiness 必须重新计算，否则会出现已不可用仍留在 App 的状态。

## 17. 推荐最终产品语义

- “登录”改为“开始使用 AI”。
- 官方账号是推荐路径，因为可用官方积分、模型和多媒体能力。
- 自定义 API 是免费/自带 key 路径，保证核心聊天和 Agent 能力。
- 官方-only 能力在自定义 API 模式下不消失，但入口显示需要登录官方账号。

这样用户心智最清晰：

```text
App 需要的是一个可用 LLM。
官方账号可以提供 LLM。
自定义 API 也可以提供 LLM。
账号能力和 LLM 能力分开判断。
```
