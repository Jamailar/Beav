# AI Model Manager

`ai_model_manager` 是 RedConvert 桌面端的 AI 模型治理出口。它实现的是方案 C：
后端先收口 provider / model / credential / route / readiness，旧 UI 和旧 IPC 继续通过
settings projection 兼容，不要求同步重写 Settings 页面。

## Responsibilities

这个模块负责统一回答四类问题：

- 当前某个能力应该用哪个 AI source、endpoint、api key、model、protocol。
- official / custom / local source 是否 ready，以及缺什么。
- `model-config.json` 和旧 settings 字段之间如何同步、投影和脱敏。
- runtime mode / tool action / capability scope 如何映射到模型 route。

这个模块不负责自然语言意图判断，不根据用户 prompt 里的业务关键词强制切模型。调用方必须传入
typed runtime mode、tool action 或 `AiModelScope`。

## Durable State

长期配置真值仍然是应用数据目录里的 `model-config.json`。旧 settings 字段仍保留，但只是兼容投影：

- `api_endpoint`
- `api_key`
- `model_name`
- `ai_sources_json`
- `ai_model_routes_json`
- `default_ai_source_id`（legacy chat projection；不要作为新的用户可见“默认供应商”能力）
- `image_*` / `video_*` / `transcription_*` / `embedding_*`
- `visual_index_*` / `video_analysis_*`
- `voice_tts_model` / `voice_clone_model` / `tts_model`

新增 AI 能力时，不能让调用方直接拼这些字段；必须先扩展 manager 的 scope / route / resolver。

## Files

- `types.rs`: typed contract。定义 `AiModelScope`、`AiProviderSource`、`AiModelRoute`、`AiResolvedRoute`、`AiReadiness`、`AiModelManagerSnapshot`。
- `routes.rs`: typed route mapping。把 runtime mode 和 tool action 映射到 `AiModelScope`。
- `mod.rs`: manager facade。提供 `snapshot`、`resolve`、`resolve_for_runtime`、`resolve_for_tool`、`readiness`、`resolve_chat_config`。
- `credentials.rs`: source、credential、official/local 判断和 secret redaction。
- `readiness.rs`: 本地 readiness 计算，不触发网络请求。
- `legacy_projection.rs`: 把 `model-config.json` 结构投影回旧 settings 字段，保障旧 UI/IPC 兼容。
- `legacy_config.rs`: `model-config.json` 的 legacy schema、读写、校验和旧 settings projection 规则。
- `store.rs`: `model-config.json` 文件读写 wrapper。对外隐藏 legacy schema 细节。
- `catalog.rs`: scope 默认模型和未来 model capability catalog 的落点。
- `official_sync.rs`: official auth event 接入点。当前主要作为后续登录事件治理入口。

## Supported Scopes

`AiModelScope` 覆盖所有现有 route：

- `chat`
- `wander`
- `team`
- `knowledge`
- `redclaw`
- `transcription`
- `embedding`
- `image`
- `video`
- `visualIndex`
- `videoAnalysis`
- `voiceTts`
- `voiceClone`

## Public Exit Points

调用方应只使用这些出口：

```rust
AiModelManager::snapshot(settings)
AiModelManager::resolve(settings, scope, request_override)
AiModelManager::resolve_for_runtime(settings, runtime_mode, request_override)
AiModelManager::resolve_for_tool(settings, action, payload)
AiModelManager::readiness(settings)
AiModelManager::readiness_value(settings)
AiModelManager::resolve_chat_config(settings, model_config)
AiModelManager::apply_settings_patch(store_path, settings)
```

`resolved_value_for_debug` 只用于 diagnostics IPC，不能作为业务协议依赖。

## Model List And Override Semantics

Renderer model pickers must not call provider-specific model-list APIs or auth-specific model arrays directly.
The only supported source for selectable models is the manager-projected settings snapshot returned by `db:get-settings`:

- `ai_sources_json[].models`
- `ai_sources_json[].modelsMeta`
- `ai_sources_json[].model`
- route defaults in `ai_model_routes_json`

Settings writes route fields as capability defaults only. A model is resolved from the explicit scope route first;
legacy root fields are projection output for older callers, not a separate provider selection surface.

Runtime and tool callers may pass a request override with `sourceId`/`source_id`, `baseURL`/`base_url`,
`apiKey`/`api_key`, `presetId`/`preset_id`, `modelName`/`model_name`/`model`, `protocol`, `provider`,
`providerTemplate`/`provider_template`, and `reasoningEffort`.
`AiModelManager::resolve(...)` applies those override fields before falling back to the saved scope route. The
legacy `default_ai_source_id` is only a migration/projection fallback when a route is missing its source.

Examples:

- Chat model picker: selected model is sent as `modelConfig`; no selection uses the chat default route.
- Image/video/media tools: selected model and selected source override in the request payload win; no selection uses the image/video default route.
- Voice tools: selected `ttsModel` / `cloneModel` remains a tool-level explicit override; provider, endpoint and key still resolve through manager.

## Default Model Seeding Policy

官方默认模型只允许在“真正首次初始化”时写入一次。判断条件必须同时满足：

- `model-config.json` 不存在。
- settings 中没有 `ai_model_defaults_initialized_at`。

只要 `ai_model_defaults_initialized_at` 已存在，就说明用户已经完成过默认模型初始化或手动模型保存。
此后即使 official auth refresh、官方模型缓存刷新、或者 `model-config.json` 缺失，也不能再次拉取默认 slot
覆盖用户 route。缺失的 `model-config.json` 只能从当前用户 settings 反向补写。

`db:save-settings` 在用户改动模型相关字段时会补 `ai_model_defaults_initialized_at`。后续新增任何
default seed 逻辑，都必须先检查这个 marker。

## Current Wiring

已接入 manager 的后端路径：

- Settings / IPC: `db:get-settings`、`db:save-settings`。
- Diagnostics: `ai-model-manager:snapshot`、`ai-model-manager:resolve`。
- Runtime diagnostics: `runtime:get-model-config` / `runtime.modelConfig.get` 返回当前有效模型配置摘要、
  app config 文件路径、脱敏后的 `model-config.json`、provider/source summary、configured routes 和
  resolved per-scope routes；agent 查询模型配置时应使用这个结构化入口，不要在 workspace 里猜配置文件。
- Readiness: `llm-readiness:get-state`、`llm-readiness:refresh`。
- Chat runtime: `runtime::resolve_chat_config` 现在是 manager adapter。
- Internal text tasks: 通过 `chat_helpers` 和 `resolve_chat_config` 间接接入。
- Image / video / embedding: `media_generation` resolver。
- Transcription: `desktop_io::resolve_transcription_settings` 和 `media.transcribe` official SRT policy。
- Visual index: `knowledge_index::document_blocks::resolve_visual_index_config`。
- Video analysis: `tools::app_cli::video_analysis_model_config`。
- Voice: `voice_service::resolve_voice_config` 的 TTS / clone route。
- Official defaults: official default slot seed 后会做 legacy projection 和 model-config sync。

已删除旧入口：

- 根部 `src/model_config.rs` 兼容 shim。
- 旧模型配置诊断 IPC。
- 旧模型配置 tool actions 和 alias。
- 通用远端模型枚举 IPC、renderer bridge 和 Settings 手动枚举链路。

允许仍然读取 legacy settings 的场景：

- migration / import / persistence scrub。
- UI compatibility projection。
- 非模型治理字段，例如 parser、rerank、visual tuning、timeout、concurrency。
- 测试 fixture。

## Adding A New AI Capability

新增能力时按这个顺序改：

1. 在 `types.rs` 增加 `AiModelScope`，补 `ALL`、`as_str`、`from_route_scope`、`legacy_model_key`。
2. 在 `routes.rs` 增加 runtime mode 或 tool action 到 scope 的映射。
3. 在 `catalog.rs` 补默认模型或 model capability 规则。
4. 在 `mod.rs` 补 endpoint/api-key/model legacy fallback。
5. 调用方改为 `AiModelManager::resolve(...)`，不要直接读 settings。
6. 增加 scope route resolution 单测和对应调用方回归测试。

## Operational Checks

推荐验证：

```bash
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test ai_model_manager
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test model_config
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test llm_readiness
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test resolve_chat_config
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test media_transcribe
CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target cargo test visual_backfill
pnpm exec tsc --noEmit
```

本地 `desktop/src-tauri/target` 可能是外部 cache symlink；如果目标不存在，使用
`CARGO_TARGET_DIR=/tmp/redconvert-src-tauri-target`。
