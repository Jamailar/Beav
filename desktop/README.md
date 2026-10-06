# Beav · Tauri 2.5.0 source

本目录提供 Beav 2.5.0 的 Tauri v2 + Rust 源码。它不是当前正式安装版的完整源码。许可范围见仓库根目录 [LICENSE](../LICENSE)。

## 文件结构

- `src/`：React + TypeScript 前端，宿主调用入口为 `src/bridge/ipcRenderer.ts`。
- `src-tauri/`：Rust 宿主、Cargo 锁文件、Tauri 配置、图标和运行资源。
- `prompts/`、`builtin-skills/`、`skills/`：提示词和技能资源，属于源码的一部分。
- `branding/`、`public/`、`shared/`、`remotion/`：品牌资源、静态文件、共享类型及视频渲染支持。
- `scripts/`：开发、检查、构建和发布脚本。
- 仓库根目录的 `Plugin/`：配套浏览器扩展及本地控制服务。

## 本地构建

准备 Node.js 22、pnpm 10、Rust stable，以及对应平台的 Tauri v2 系统依赖。先在仓库根目录构建浏览器扩展：

```sh
cd Plugin
pnpm install --frozen-lockfile
pnpm check
cd ../desktop
pnpm install --frozen-lockfile
pnpm build
```

`pnpm build` 检查 TypeScript 并构建前端。启动桌面应用前，按 [FFmpeg 二进制说明](src-tauri/binaries/README.md) 准备本平台带 target triple 后缀的 FFmpeg 和 FFprobe；它们是未纳入 Git 的第三方构建资源，不是缺失的应用源码。Tauri 打包还会使用刚构建的 `Plugin/dist/extension`。

```sh
pnpm tauri:dev
```

AI、发布及第三方平台能力需要自行配置账号、模型 endpoint 和密钥。仓库不提供生产凭证、签名私钥或公证账号。正式签名、跨平台安装包和线上服务兼容性不由前端构建通过来保证。

## 历史与验证范围

详见 [源码基线与历史说明](docs/source-baseline.md)。模块说明保留在相邻目录；内部规划、事故复盘、本机 Agent 配置不属于公开源码文档。
