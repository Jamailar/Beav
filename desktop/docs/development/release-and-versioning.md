# Release And Versioning

Status: Current

## Source Of Truth

- 根版本号： [package.json](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/package.json)
- Rust 元数据同步： [scripts/sync-version.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/scripts/sync-version.mjs)

## Rules

- 修改版本时，只改根 `package.json`。
- 不要手改 `src-tauri/Cargo.toml` 和 `Cargo.lock` 的 root version。
- 构建和 dev 启动会触发同步逻辑，脚本失败时先修同步脚本，不要手动打补丁。

## Main Commands

```bash
pnpm build
pnpm tauri:build
```

## Verification

- 运行 `pnpm build`
- 确认 Rust 元数据已同步
- 如涉及打包，再跑一次 `pnpm tauri:build`
