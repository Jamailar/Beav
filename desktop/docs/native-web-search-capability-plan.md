---
doc_type: plan
execution_status: completed
last_updated: 2026-05-01
---

# Native Web Search Capability

## Goal

RedConvert should prefer model-native web search when a provider exposes it, instead of owning a separate web search API integration by default. The product still keeps `web.fetch` for explicit URL retrieval, but broad web search is treated as a provider capability, not a first-party crawler/search engine.

## Architecture

1. Provider capability detection lives in `desktop/src-tauri/src/provider_compat/`.
   - `NativeWebSearchSupport::None` means the current provider profile does not advertise native search.
   - `NativeWebSearchSupport::OpenAiChatCompletions` means the selected OpenAI model supports the current `/chat/completions` native search path through `web_search_options`.
   - `NativeWebSearchSupport::OpenAiResponses` means the official OpenAI endpoint can support native search, but it requires an OpenAI Responses transport rather than the existing Chat Completions request body.
2. User/model intent is stored on `ResolvedChatConfig.web_search_mode`.
   - `auto`: default; use native search only when the selected provider and transport can support it.
   - `native`: require native provider search when supported.
   - `disabled`: never request native search.
3. Runtime request policy is resolved by `ProviderProfile::web_search_policy`.
   - The policy reports whether native search is requested.
   - The policy also reports the required transport so the runtime does not inject unsupported provider-specific fields into `/chat/completions`.
4. The OpenAI interactive runtime records the resolved policy in debug logs.
   - For `gpt-5-search-api`, the runtime adds `web_search_options: {}` to the existing Chat Completions body.
   - For Responses-only models, current behavior intentionally does not add a `web_search` function tool or a non-standard Chat Completions field.
   - This preserves compatibility for OpenAI-compatible gateways, Qwen, DeepSeek, MiniMax, and other providers that share the same transport shape but not OpenAI Responses semantics.

## Existing Libraries vs Self-Built Code

Use existing provider SDK/API surfaces for actual search execution:

- OpenAI Chat Completions: use `gpt-5-search-api` with `web_search_options` when the product must stay on the current transport.
- OpenAI Responses: use the hosted `web_search` tool when the runtime grows an `openai_responses` transport.
- Gemini / Anthropic: add provider-native grounding/search only after a provider-specific transport adapter exists and returns structured citations.
- URL fetch: keep the existing `app_cli(action="web.fetch")` path for user-provided URLs.

Self-built code should stay limited to:

- capability detection;
- strict configuration parsing;
- request policy resolution;
- provider-specific transport adapters;
- citation normalization for the app event stream.

Do not self-build:

- a general web search index;
- a SERP scraping layer;
- a broad crawler;
- a hidden search tool that returns free-form text.

## Implementation Details

Current completed changes:

- Added `provider_compat/search.rs` for `WebSearchMode`, `NativeWebSearchSupport`, and `WebSearchRequestPolicy`.
- Extended `ProviderCapabilities` with `native_web_search`.
- Marked only official OpenAI endpoints as native-search capable; OpenAI-compatible gateways remain `None`.
- Enabled the current Chat Completions native search path for `gpt-5-search-api` by adding `web_search_options: {}`.
- Extended `ResolvedChatConfig` and config resolution to read `webSearchMode`, `web_search_mode`, `nativeWebSearch`, or `webSearch`.
- Included web search settings in runtime warm fingerprints so cached runtime context refreshes when the mode changes.
- Added debug tracing in the OpenAI interactive runtime when native search is requested but requires a different transport.

Next transport step:

1. Add `llm_transport/openai_responses.rs`.
2. Convert canonical messages and function tools into Responses API input/tool declarations.
3. Enable native web search only when `web_search_policy.required_transport == Some("openai_responses")` and that transport is selected.
4. Normalize citations/search metadata into the existing runtime event stream.

## Performance Strategy

- Keep capability resolution pure and allocation-light; it runs per turn.
- Avoid network calls during provider detection.
- Include search mode in warm fingerprints to prevent stale warmed sessions.
- Keep URL fetch and native search separated so explicit URL retrieval does not pay search latency.
- When Responses support is added, stream text deltas and citations incrementally instead of waiting for a full response object.

## Option Comparison

| Option | Pros | Cons | Recommendation |
| --- | --- | --- | --- |
| Build our own search API layer | Full control; provider independent | Requires API keys, ranking, citation hygiene, quota controls, compliance work | Not recommended by default |
| Rely only on model-native search | Lowest integration surface; best fit for modern models | Provider-specific transports; inconsistent citation shapes | Recommended primary path |
| Hybrid native-first plus external fallback | Best reliability when native search is missing | More complexity; still needs external search vendor | Future optional path |

Recommended architecture: native-first, no external search integration by default, with an explicit fallback interface added only if product requirements prove native provider search is insufficient.
