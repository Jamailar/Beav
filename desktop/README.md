# Beav 2.6.0 源码

本目录提供 Beav 2.6.0 的 Tauri v2 + Rust 源码，许可范围见仓库根目录 [LICENSE](../LICENSE)。

## 文件结构

- `src/`：React + TypeScript 前端，宿主调用入口为 `src/bridge/ipcRenderer.ts`。
- `src-tauri/`：Rust 宿主、Cargo 锁文件、Tauri 配置、图标和运行资源。
- `prompts/`、`builtin-skills/`、`skills/`：提示词和技能资源，属于源码的一部分。
- `branding/`、`public/`、`shared/`、`remotion/`：品牌资源、静态文件、共享类型及视频渲染支持。
- `scripts/`：开发、检查、构建和发布脚本。
- 仓库根目录的 `Plugin/`：配套浏览器扩展及本地控制服务。

## 本地构建

准备 Node.js 22、pnpm 10.28.2、Rust stable，以及对应平台的 Tauri v2 系统依赖。先在仓库根目录构建浏览器扩展：

```sh
cd Plugin
pnpm install --frozen-lockfile
pnpm check
cd ../desktop
pnpm install --frozen-lockfile
pnpm build:beav
```

`pnpm build:beav` 检查 TypeScript 并构建 Beav 前端。启动桌面应用前，按 [FFmpeg 二进制说明](src-tauri/binaries/README.md) 准备本平台带 target triple 后缀的 FFmpeg 和 FFprobe；这两项是从第三方获取的构建依赖。Tauri 打包还会使用刚构建的 `Plugin/dist/extension`。

```sh
pnpm tauri:dev:beav
```

AI、发布及第三方平台能力需要自行配置账号、模型 endpoint 和密钥。正式签名和公证使用维护者自己的凭证。

## 历史与验证范围

详见 [源码基线与历史说明](docs/source-baseline.md)。模块说明位于相邻源码目录。
