# `media_generation/`

## Responsibilities

- `image.rs` owns image generation request normalization, provider-specific payloads, polling, and image asset materialization.
- `video.rs` owns video generation request body construction, task polling, status extraction, and provider submission.
- `../media_generation.rs` keeps shared settings resolution, transport helpers, media result extraction, embedding helpers, and tests.

## Rules

- Keep `media_runtime/` as the canonical job runtime and queue owner.
- Request-type provider behavior belongs in the matching request module.
- Do not move job projection, queue persistence, or notification behavior into this provider adapter layer.
