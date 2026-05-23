# `commands/official/`

Official account IPC channel handlers split by control-plane responsibility. The parent `commands/official.rs` keeps shared auth/session/cache helpers and the public `handle_official_channel` router.

## Channel Modules

- `auth_flow.rs`: realm config, session bootstrap, SMS/WeChat login, logout, refresh, and session compatibility channels.
- `account.rs`: account summary, points, and pricing cache access.
- `api_keys.rs`: API key list/create/current-key selection.
- `billing.rs`: products, orders, call records, payment form and payment status.
- `models.rs`: official model list refresh and source sync.

## Rules

- Channel modules stay dispatch-only and call shared helpers in the parent module.
- Auth generation checks remain explicit; do not reuse stale login writes after logout or realm switch.
- Billing and API key channels must update settings through `apply_official_settings_update` so renderer and runtime auth state stay synchronized.
