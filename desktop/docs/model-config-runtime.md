---
doc_type: architecture
execution_status: completed
last_updated: 2026-05-13
---

# Model Config Runtime

RedBox stores user-visible model provider and route configuration in:

```text
~/Library/Application Support/RedBox/model-config.json
```

This file is the readable configuration center for model selection. Credentials remain outside this file: official credentials continue through the official auth/session runtime, and legacy custom keys are preserved in the existing settings projection until a dedicated secure keyring migration is added.

## Shape

```json
{
  "version": 1,
  "defaults": {
    "sourceId": "redbox_official_auto"
  },
  "providers": [
    {
      "id": "redbox_official_auto",
      "name": "RedBox Official",
      "presetId": "redbox-official",
      "baseURL": "https://api.ziz.hk/thrive/v1",
      "protocol": "openai",
      "model": "qwen3.5-plus",
      "credentialRef": "settings:redbox_official_auto"
    }
  ],
  "routes": {
    "chat": { "mode": "official", "sourceId": "redbox_official_auto", "model": "qwen3.5-plus" },
    "wander": { "mode": "official", "sourceId": "redbox_official_auto", "model": "qwen3.5-plus" },
    "image": { "mode": "official", "sourceId": "redbox_official_auto", "model": "gpt-image-2" },
    "videoAnalysis": { "mode": "official", "sourceId": "redbox_official_auto", "model": "qwen3.5-omni-flash" }
  },
  "modelOverrides": {}
}
```

## Runtime Contract

- Startup calls `model_config::load_model_config_into_settings`, which reads `model-config.json` and applies provider/routes into the existing settings snapshot.
- Settings saves call `model_config::sync_model_config_file`, keeping the JSON file in sync with the current settings without writing API keys into the file.
- Chat runtime still resolves through `resolve_chat_config`; the model config layer feeds the same legacy keys so existing runtime paths keep working.
- Media routes also project into legacy fields such as `image_model`, `video_model`, `visual_index_model`, and `video_analysis_model`.

## Query Surface

Renderer / diagnostics:

```ts
window.ipcRenderer.readModelConfig()
window.ipcRenderer.getEffectiveModelConfig('chat')
```

Agent tool surface:

```text
app_cli model-config read
app_cli model-config effective --runtime-mode chat
```

Both surfaces return redacted values. They expose `apiKeyPresent`, never the key.

## Implementation Boundary

Use existing libraries for transport and processing:

- LLM HTTP transport stays in `llm_transport` / provider runtime.
- Video and media processing stays on `ffmpeg` and existing media runtimes.
- JSON parsing uses `serde_json`.

Self-owned RedBox logic:

- Model config schema and migration.
- Route-to-runtime resolver.
- Secret-preserving projection back into settings.
- Redacted diagnostics/query payloads.
