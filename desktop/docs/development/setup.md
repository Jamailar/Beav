# Development Setup

Status: Current

## Baseline

- Node: `>=22 <23`
- Package manager: `pnpm`
- Workspace root: [package.json](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/package.json)
- Tauri host: `src-tauri/`

## Install

```bash
pnpm install
```

## Main Commands

```bash
pnpm build
pnpm tauri:dev
pnpm tauri:build
pnpm ipc:inventory
pnpm remotion:render -- <configPath> <outputPath> [scale]
```

## What Each Command Does

- `pnpm build`: 运行 `sync-version`、TypeScript 构建和 Vite 构建
- `pnpm tauri:dev`: 启动 Tauri 开发环境，配合 `tauri-before-dev` 复用或拉起 Vite
- `pnpm tauri:build`: 构建桌面应用
- `pnpm ipc:inventory`: 输出 IPC 清单文档
- `pnpm remotion:render`: 用 Remotion 渲染视频

## Extra Verification

当改动 Rust host 时，建议追加：

```bash
cd src-tauri
cargo fmt --check
cargo check
```

## Environment Notes

- 许多 AI 能力依赖用户本地配置的 endpoint、model、key。
- YouTube、公众号、MCP、sidecar 等能力都依赖本机外部环境，不要把“本地没配好”误判成代码 bug。
- 端口复用、版本同步、前端 dev server 由 [scripts/tauri-before-dev.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/scripts/tauri-before-dev.mjs) 和 [scripts/sync-version.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/scripts/sync-version.mjs) 协助处理。
