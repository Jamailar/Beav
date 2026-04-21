# `scripts/`

本目录放开发和构建辅助脚本。

## Current Scripts

- [extract-ipc-inventory.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/scripts/extract-ipc-inventory.mjs): 生成 IPC 清单文档
- [sync-version.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/scripts/sync-version.mjs): 同步根版本号到 Rust 元数据
- [tauri-before-dev.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/scripts/tauri-before-dev.mjs): 开发期复用或拉起 Vite
- [release-utils.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/scripts/release-utils.mjs): 发布脚本共用命令、临时配置与产物查找工具
- [build-all-release.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/scripts/build-all-release.mjs): `release:all` 总控脚本，固定先走 `ssh jamdebian` 远程构建 Windows，再构建 macOS，并输出统一结果摘要
- [build-mac-release.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/scripts/build-mac-release.mjs): 本地发现 `Developer ID Application` 证书，构建、签名、notarize、staple 并验证 macOS 安装包
- [setup-mac-notary-profile.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/scripts/setup-mac-notary-profile.mjs): 用 `xcrun notarytool store-credentials` 保存 Apple notarization profile
- [build-windows-release.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/scripts/build-windows-release.mjs): 非 Windows 主机默认通过 `ssh jamdebian` 远程构建并拉回 NSIS 安装包；也支持在本机走原生/本地交叉打包，并支持注入自定义签名命令

## Artifact Paths

- 最终 macOS 安装包复制到 `artifacts/installers/macos/`
- 最终 Windows 安装包复制到 `artifacts/installers/windows/`
- 构建摘要写到 `artifacts/release/`
- `artifacts/` 应保持为本地构建输出目录，不进入 Git

## Rules

- 脚本输出路径必须明确、稳定。
- 报错信息要足够定位问题，不要吞异常。
- 脚本变更后至少手动运行一次。

## Related Docs

- [docs/development/setup.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/docs/development/setup.md)
- [docs/release-packaging.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/docs/release-packaging.md)
