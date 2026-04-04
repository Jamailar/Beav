# LexBox

`LexBox/` 是把现有 `desktop/` 应用迁移为 Rust 驱动桌面宿主的工作区。

当前阶段目标不是重新做一个 UI，而是优先把宿主层重建出来：

- 复用 `desktop/src/components/Layout.tsx`
- 复用 `desktop/src/pages/Subjects.tsx`
- 复用 `desktop/src/pages/Workboard.tsx`
- 用 Rust 接管设置、空间、主体库和基础 IPC 兼容层
- 为后续 `chat / manuscripts / knowledge / redclaw` 迁移保留稳定接口

## 当前命令

- `pnpm install`
- `pnpm tauri:dev`
- `pnpm tauri:build`
- `pnpm ipc:inventory`

## 当前状态

- 已建立 Tauri v2 + React/Vite 工程
- 已建立 Electron 风格 `window.ipcRenderer` 兼容桥
- 已在 Rust 侧实现：
  - `db:*`
  - `spaces:*`
  - `subjects:*`
  - `app:get-version`
  - `app:open-release-page`
  - `clipboard:*`
  - `indexing:get-stats`
  - `work:list`
- 尚未迁移：
  - Chat 流式事件与工具确认链路
  - Manuscripts 文件树与布局存储
  - Knowledge 索引与导入流水线
  - RedClaw 长周期后台执行器

## 备注

当前环境中 `cargo` / `rustc` 不在 PATH，仓库已经落好了 Rust 工程文件，但本轮无法本地编译验证。
