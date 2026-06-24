# RedBox 发布打包

本文件定义 RedBox 当前可重复执行的桌面端打包方式，覆盖：

- macOS 本地签名 + notarization + staple + 验证
- 非 Windows 主机通过 `ssh jamdebian` 远程打包 Windows 并拉回产物
- 非 Linux 主机通过 `ssh jamdebian` 远程打包 Linux 并拉回产物
- Windows 原生打包
- 远端或本机的 `cargo-xwin` Windows NSIS 交叉打包
- Linux 原生打包
- Tauri 原生 updater 签名资产

## 命令入口

- `pnpm release:mac`
- `pnpm release:mac:setup-notary`
- `pnpm release:win`
- `pnpm release:linux`
- `pnpm release:all`
- `pnpm release:oss`

## 一键执行三个平台

直接运行：

```bash
pnpm release:all
```

执行行为：

1. 固定执行 `node ./scripts/build-windows-release.mjs --mode remote --host jamdebian`
2. 再执行 `node ./scripts/build-mac-release.mjs`
3. 再执行 `node ./scripts/build-linux-release.mjs --mode remote --host jamdebian`
4. 即使其中一个平台失败，也会继续跑其他平台
5. 最后统一输出三个平台的构建结果和安装包路径

这条总控脚本的目的不是简单串联命令，而是保证：

- Windows 永远走 `ssh jamdebian` 远程构建再拉回
- Linux 在非 Linux 主机上默认也走 `ssh jamdebian` 远程构建再拉回
- macOS notarization 上传遇到瞬时网络错误时会自动重试
- 单个平台失败时，另一个平台的构建结果仍然会被明确输出

## 一键打包并发布到开源仓库

直接运行：

```bash
pnpm release:oss -- --repo <owner/name>
```

执行行为：

1. 先复用 `node ./scripts/build-all-release.mjs` 完成 Windows + macOS + Linux 安装包构建
2. 读取 `artifacts/release/mac-build-summary.json`、`artifacts/release/windows-build-summary.json` 和 `artifacts/release/linux-build-summary.json`
3. 默认按 `package.json.version` 生成 `vX.Y.Z` tag
4. 将该 tag 推送到开源 remote，默认 remote 名为 `export-sanitized`
5. 自动生成 `artifacts/release/vX.Y.Z-release-notes.md`
6. 通过 `gh release create` 在 GitHub 开源仓库创建 release，并上传安装包和 updater 签名资产
7. RedBoxweb 同步任务把安装包、updater 包和签名镜像到 OSS manifest，桌面端一键更新只读取该 manifest

默认前提：

- 本机已安装并登录 `gh`
- 开源 remote 已配置
- 如果 `export-sanitized` 不是 GitHub URL，需要显式传 `--repo owner/name`，或者设置 `REDBOX_OPEN_SOURCE_GITHUB_REPO`

常用参数：

- `--repo owner/name`：GitHub release 目标仓库
- `--remote export-sanitized`：推送 tag 的 git remote 名称
- `--tag v1.9.3`：覆盖默认 tag
- `--title "RedBox v1.9.3"`：覆盖 release 标题
- `--draft`：创建草稿 release
- `--prerelease`：标记为预发布
- `--skip-build`：跳过打包，直接使用现有 `artifacts/release/*.json` 和安装包

## Tauri 一键更新资产

桌面端使用 Tauri v2 updater。这个链路必须使用现成的 `tauri-plugin-updater`，不要自研安装器替换系统级安装流程；自研部分只负责发布资产命名、OSS manifest 和应用内最小 UI。

构建要求：

- `desktop/src-tauri/tauri.conf.json` 启用 `bundle.createUpdaterArtifacts`。
- `plugins.updater.pubkey` 固定写入公开签名 key。
- 私钥不进入仓库。默认本机路径是 `~/.tauri/redbox-updater.key`，也可以显式设置 `TAURI_SIGNING_PRIVATE_KEY` 或 `TAURI_SIGNING_PRIVATE_KEY_PATH`。
- Windows 远程构建机也必须有同一把 updater 私钥，默认路径同样是 `~/.tauri/redbox-updater.key`。

发布产物：

- macOS：`*.app.tar.gz` 和同名 `*.app.tar.gz.sig`
- Windows NSIS：`*-setup.exe.zip` 和同名 `*-setup.exe.zip.sig`
- Linux AppImage：`*.AppImage.tar.gz` 和同名 `*.AppImage.tar.gz.sig`

发布脚本会把这些 updater 资产写入平台 summary，并由 `pnpm release:oss` 上传到 GitHub release。RedBoxweb 同步任务随后镜像到 OSS 的 `updaters/<tag>/`，并把 `.sig` 内容写进 `manifests/latest.json` 的 `updaterAssets`。

客户端更新流程：

1. 前端弹出已有的更新提示弹窗。
2. 用户点击“安装更新”。
3. Rust command 调用 Tauri updater 检查 `/api/updates/tauri`。
4. updater 校验 manifest 里的签名后下载并安装。
5. macOS / Linux 安装完成后自动重启；Windows passive installer 完成后由安装器接管。

## macOS

### 目标

`pnpm release:mac` 默认会连续产出 `aarch64-apple-darwin + x86_64-apple-darwin` 两个安装包，并执行下面这条完整链路：

1. 从本机 keychain 自动查找 `Developer ID Application` 证书。
2. 用该证书执行 Tauri `build`，生成签名后的 `.app` 与 `.dmg`。
3. 用 `xcrun notarytool` 提交 `.dmg` 到 Apple notarization。
4. 对 `.dmg` 执行 `staple`。
5. 执行 `codesign`、`stapler validate`、`spctl` 验证。
6. 将最终产物和摘要写入 `artifacts/release/`。

### 当前本机已发现证书

当前机器可见的发布证书是：

- `Developer ID Application: Hunan Xizi Culture Co., Ltd. (N9KF8X5S99)`

脚本默认优先使用该证书。需要手动覆盖时，可设置：

- `APPLE_SIGNING_IDENTITY`

### notarization 凭据

根据 Tauri 官方 macOS 签名文档，公证需要下面两类认证方式之一：

- `APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_PATH`
- `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`

文档来源：

- [Tauri macOS signing/notarization](https://v2.tauri.app/zh-cn/distribute/sign/macos/)

本仓库额外支持第三种更适合本机开发机的方式：

- `APPLE_NOTARY_PROFILE`

这个值对应 `xcrun notarytool store-credentials` 存在 keychain 里的 profile 名。推荐你本机使用它，因为：

- 密码不需要每次进环境变量
- `pnpm release:mac` 可以直接重用 keychain 中的凭据
- 脚本不会把任何密码写进仓库

### 首次配置 notarization profile

推荐先执行：

```bash
pnpm release:mac:setup-notary -- --profile redbox-notary --apple-id <your-apple-id> --team-id N9KF8X5S99
```

如果你已经准备好 app-specific password，也可以直接带上环境变量：

```bash
APPLE_PASSWORD=<app-specific-password> pnpm release:mac:setup-notary -- --profile redbox-notary --apple-id <your-apple-id> --team-id N9KF8X5S99
```

保存成功后，正式打包时使用：

```bash
APPLE_NOTARY_PROFILE=redbox-notary pnpm release:mac
```

### notarization 上传重试

`pnpm release:mac` 现在会在 `xcrun notarytool submit` 遇到常见瞬时网络错误时自动重试，默认：

- 重试次数：`3`
- 重试间隔：`5000ms`

可通过下面参数覆盖：

```bash
pnpm release:mac -- --notary-retries 5 --notary-retry-delay-ms 8000
```

或者在一键构建时：

```bash
pnpm release:all -- --mac-notary-retries 5 --mac-notary-retry-delay-ms 8000
```

### 产物

- `src-tauri/target/<target>/release/bundle/macos/RedBox.app`
- `src-tauri/target/<target>/release/bundle/dmg/RedBox_<version>_<arch>.dmg`
- `src-tauri/target/<target>/release/bundle/macos/RedBox.app.tar.gz`
- `src-tauri/target/<target>/release/bundle/macos/RedBox.app.tar.gz.sig`
- `artifacts/installers/macos/RedBox_<version>_<arch>.dmg`
- `artifacts/installers/macos/RedBox_<version>_<arch>.app.tar.gz`
- `artifacts/installers/macos/RedBox_<version>_<arch>.app.tar.gz.sig`
- `artifacts/release/mac-build-summary.json`

### 可选参数

- `REDBOX_MAC_TARGETS=aarch64-apple-darwin,x86_64-apple-darwin pnpm release:mac`
- `REDBOX_MAC_TARGET=universal-apple-darwin pnpm release:mac`

如果要打 universal 包，必须先安装额外 Rust target：

```bash
rustup target add x86_64-apple-darwin
```

## Windows

### 目标

`pnpm release:win` 默认连续生成三种 Windows NSIS 安装包：

- `x86_64-pc-windows-msvc`
- `aarch64-pc-windows-msvc`
- `i686-pc-windows-msvc`

优先推荐：

- 在 macOS 开发机上直接执行 `pnpm release:win`，由脚本通过 `ssh jamdebian` 远程构建并将产物拉回本地 `artifacts/installers/windows/`
- 如果确实在 Windows 机器上原生执行，再显式指定 `--mode native`

备选方案：

- 在远端 Linux 或本机上使用 Tauri 官方文档里的 `cargo-xwin` + NSIS 交叉打包

文档来源：

- [Tauri Windows Installer](https://tauri.app/distribute/windows-installer/)
- [Tauri Windows Code Signing](https://v2.tauri.app/zh-cn/distribute/sign/windows/)

### 默认远程打包

在 macOS/Linux 开发机上直接运行：

```bash
pnpm release:win
```

默认行为：

1. `rsync` 当前仓库到 `ssh jamdebian:/home/jam/build/redbox-tauri-win-release`
2. 在远端执行 `pnpm install --frozen-lockfile`
3. 在远端以 `REDBOX_WINDOWS_MODE=local` 触发本地交叉打包
4. 从远端拉回 `.exe/.zip/.sig/.yml/.blockmap` 到 `artifacts/installers/windows/`
5. 本地写入 `artifacts/release/windows-build-summary.json`

可覆盖的远端参数：

- `REDBOX_REMOTE_HOST`，默认 `jamdebian`
- `REDBOX_REMOTE_WORKDIR`，默认 `/home/jam/build/redbox-tauri-win-release`

### Windows 原生打包

在 Windows 主机上直接运行：

```bash
pnpm release:win -- --mode native
```

默认 targets：

- `x86_64-pc-windows-msvc`
- `aarch64-pc-windows-msvc`
- `i686-pc-windows-msvc`

### 远端或本机交叉打包前提

根据 Tauri 官方文档，远端 Linux 或本机交叉打包 Windows NSIS 需要：

1. `rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc i686-pc-windows-msvc`
2. `cargo install --locked cargo-xwin`
3. `nsis`
4. `llvm-rc`

远端 Debian 或 macOS 上都需要满足这些工具链前提；macOS 上对应安装命令通常是：

```bash
brew install nsis llvm
cargo install --locked cargo-xwin
rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc i686-pc-windows-msvc
```

同时需要把 LLVM bin 目录放进 PATH，例如 Apple Silicon Homebrew：

```bash
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
```

如果你要绕过默认远程模式，在本机强制走交叉打包：

```bash
pnpm release:win -- --mode local
```

### Windows 签名

Windows 安装包签名不在仓库里硬编码。脚本支持通过环境变量注入 Tauri `bundle.windows.signCommand`：

```bash
REDBOX_WINDOWS_SIGN_COMMAND='trusted-signing-cli -e https://... -a ... -c ... -d RedBox %1' pnpm release:win
```

### 可选参数

- `REDBOX_WINDOWS_TARGETS=x86_64-pc-windows-msvc,aarch64-pc-windows-msvc,i686-pc-windows-msvc pnpm release:win`
- `pnpm release:win -- --targets x86_64-pc-windows-msvc`

如果你要强制没有签名命令时直接失败：

```bash
REDBOX_REQUIRE_WINDOWS_SIGN=1 pnpm release:win
```

### 产物

- `artifacts/installers/windows/*-setup.exe`
- `artifacts/installers/windows/*-setup.exe.zip`
- `artifacts/installers/windows/*-setup.exe.zip.sig`
- `artifacts/release/windows-build-summary.json`

## Linux

### 目标

`pnpm release:linux` 默认生成 Linux x64 桌面端 `.deb` 安装包，并同时生成 Tauri updater 使用的 AppImage 压缩包与签名。

在 Linux 主机上默认原生打包；在 macOS / 非 Linux 主机上默认通过 `ssh jamdebian` 远程构建并拉回产物。

### 默认远程打包

在 macOS 开发机上直接运行：

```bash
pnpm release:linux
```

默认行为：

1. `rsync` 当前仓库到 `ssh jamdebian:/home/jam/build/redbox-tauri-linux-release`
2. 在远端执行 `pnpm install --frozen-lockfile`
3. 在远端以 `REDBOX_LINUX_MODE=local` 触发 Linux 原生打包
4. 从远端拉回 `.deb`、`*.AppImage.tar.gz` 和 `*.AppImage.tar.gz.sig` 到 `artifacts/installers/linux/`
5. 本地写入 `artifacts/release/linux-build-summary.json`

### Linux 主机原生打包

在 Linux 主机上直接运行：

```bash
pnpm release:linux -- --mode local
```

默认 target：

- `x86_64-unknown-linux-gnu`

### 产物

- `src-tauri/target/<target>/release/bundle/deb/*.deb`
- `src-tauri/target/<target>/release/bundle/appimage/*.AppImage.tar.gz`
- `src-tauri/target/<target>/release/bundle/appimage/*.AppImage.tar.gz.sig`
- `artifacts/installers/linux/*.deb`
- `artifacts/installers/linux/*.AppImage.tar.gz`
- `artifacts/installers/linux/*.AppImage.tar.gz.sig`
- `artifacts/release/linux-build-summary.json`

## 用户需要手动准备的密钥

macOS 完整验证安装包目前还缺这一项人工操作：

1. 准备 Apple notarization 凭据
2. 推荐做法：创建一个 app-specific password，然后运行 `pnpm release:mac:setup-notary`

如果你更偏向 API key 方式，则需要你在 App Store Connect 创建并下载：

- `APPLE_API_ISSUER`
- `APPLE_API_KEY`
- 对应 `.p8` 私钥文件路径 `APPLE_API_KEY_PATH`

在这些凭据配置完成之前，`pnpm release:mac` 会拒绝继续，因为它的目标就是产出完整 notarized 包，而不是只打一个 ad-hoc 或未公证的半成品。
