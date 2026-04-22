# RedBox System Overview

Status: Current

## Scope

本文件描述 RedBox 当前 Tauri 工作区的总架构，只覆盖当前仓库 `desktop/`，不覆盖旧 `archive/desktop-electron/` 实现细节。

## Surfaces

- Renderer: `src/`
- Host: `src-tauri/src/`
- Shared contracts: `shared/`
- AI assets: `prompts/`、`builtin-skills/`、`skills/`
- Build/runtime scripts: `scripts/`、`remotion/`

## Primary Flows

### Renderer To Host

1. `src/main.tsx` 启动 renderer 并安装 IPC bridge。
2. `src/App.tsx` 负责顶层视图切换与懒加载。
3. 页面和组件通过 `window.ipcRenderer` 调用宿主能力。
4. `src-tauri/src/main.rs` 注册 command 和全局状态。
5. 领域逻辑进入 `src-tauri/src/commands/*`、`runtime/*`、`persistence/*`、`scheduler/*` 等模块。

### Runtime Events

1. Host 统一通过 `src-tauri/src/events/` 发事件。
2. Renderer 通过 `src/runtime/runtimeEventStream.ts` 消费统一 `runtime:event` 和兼容事件。
3. UI 页面根据 session/task 维度更新局部状态，而不是全页重置。

### Workspace Data

1. 命令层读取最小状态快照。
2. `persistence/` 和 `workspace_loaders.rs` 完成文件系统读取与 hydrate。
3. 结果回写到内存状态并发出事件。

### Video Pipeline

1. 视频编辑 UI 主要在 `src/components/manuscripts/`。
2. 视频编辑器局部状态在 `src/features/video-editor/store/`。
3. Remotion 入口在 `src/remotion/`，CLI 渲染脚本在 `remotion/render.mjs`。
4. 视频相关共享协议在 `shared/redboxVideo.ts` 和稿件包协议中定义。

## Architectural Boundaries

- 页面代码不直接依赖 Tauri 原始 API，统一经过 bridge。
- `main.rs` 是装配层，不继续堆复杂业务。
- workspace 扫描不在 renderer 中做。
- runtime/tool/skill 边界优先用 typed contract，不靠消息文本启发式。

## High-Risk Areas

- `src/App.tsx` 的页面切换和缓存策略
- `src/bridge/ipcRenderer.ts` 的 fallback/timeout/normalize 行为
- `src-tauri/src/main.rs` 的注册、状态和兼容入口
- `src-tauri/src/runtime/` 与 `src-tauri/src/events/` 的协同
- `src/components/manuscripts/` 与 `src/remotion/` 的视频协议一致性

## Verification

- renderer 改动：验证页面即时展示、后台刷新和错误回退
- host 改动：验证真实 command/event 调用
- runtime 改动：验证流式输出、工具调用、任务状态
- video 改动：验证预览、导出、素材路径处理
