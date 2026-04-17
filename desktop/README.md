# RedBox

`RedBox/` 是 RedConvert 桌面端迁移到 Tauri v2 + Rust 宿主的独立工作区。

## Boundaries

- 只在 `RedBox/` 内开发、运行和构建。
- `desktop/` 只作为只读参考源，不参与 `RedBox` 运行时与构建。
- 前端源码在 `RedBox/src/` 独立维护。
- 宿主源码在 `RedBox/src-tauri/` 独立维护。
- 前端兼容面仍暴露 `window.ipcRenderer`，内部统一路由到 Tauri command/event。

## Commands

- `pnpm install`
- `pnpm build`
- `pnpm tauri:dev`
- `pnpm tauri:build`
- `pnpm ipc:inventory`

## Current Status

- 前端 IPC channel 已全量有 Rust host 路由。
- Tauri debug build 已通过。
- macOS `.app` bundle 已启用。
- `RedBox/src-tauri/src/main.rs` 目前承载 Rust host 内核：
  - app / settings / spaces / subjects
  - manuscripts / media / cover / knowledge
  - chat / runtime / sessions / tasks / background
  - assistant daemon / RedClaw / MCP / skills / diagnostics
  - Advisors / YouTube / yt-dlp
  - WeChat official local binding and draft flow
  - embedding / similarity / wander

## External Integrations

很多外部能力现在已经有真实执行路径，但仍取决于本机配置和第三方账号：

- AI chat / image / video / transcription / embedding 需要可用 endpoint、model 和 key。
- WeChat official draft publishing 需要公众号 AppID/Secret、有效 access token，以及封面素材 `thumb_media_id` 或可上传封面图。
- Weixin sidecar 需要用户配置可执行的 `sidecarCommand`、args、cwd、env，并由该 sidecar 产出可读取的登录状态 JSON。
- YouTube 字幕下载需要本机 `yt-dlp` 可用。
- MCP stdio / SSE / streamable-http 需要对应 server 可启动或可访问。

## Verification

已验证的基础链路：

- `cargo fmt --check && cargo check`
- `pnpm build`
- `pnpm tauri build --debug`
- 调试产物短时启动 smoke

当前调试产物：

- `RedBox/src-tauri/target/debug/redbox`
