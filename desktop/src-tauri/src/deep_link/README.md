# `deep_link`

## Responsibility

- Owns the desktop `beav://` custom URL scheme entrypoint.
- Parses untrusted external URLs into typed, allowlisted intents.
- Emits `app:deep-link` events and keeps a small pending queue so cold-start links are not lost before the renderer mounts.

## Contract

Supported actions:

- `beav://open`
- `beav://chat/new?text=...`
- `beav://import/url?url=https%3A%2F%2F...`
- `beav://knowledge/save?url=https%3A%2F%2F...`
- `beav://skills`
- `beav://skills/open?packageId=...`

This module must not execute arbitrary IPC channels, write workspace files, start paid AI/media work, delete data, publish content, or read local file paths. It only creates a safe intent for the renderer to route through normal in-app confirmation flows.

## Implementation Notes

- OS registration is handled by `tauri-plugin-deep-link`.
- Running-instance forwarding is handled by `tauri-plugin-single-instance` with the `deep-link` feature.
- URL parsing uses the Rust `url` crate. Only `http` and `https` external URLs are accepted.
