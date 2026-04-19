# `scripts/`

本目录放开发和构建辅助脚本。

## Current Scripts

- [extract-ipc-inventory.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/scripts/extract-ipc-inventory.mjs): 生成 IPC 清单文档
- [sync-version.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/scripts/sync-version.mjs): 同步根版本号到 Rust 元数据
- [tauri-before-dev.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/scripts/tauri-before-dev.mjs): 开发期复用或拉起 Vite

## Rules

- 脚本输出路径必须明确、稳定。
- 报错信息要足够定位问题，不要吞异常。
- 脚本变更后至少手动运行一次。

## Related Docs

- [docs/development/setup.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/docs/development/setup.md)
