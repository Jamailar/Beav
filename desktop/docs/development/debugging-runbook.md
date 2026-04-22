# Debugging Runbook

Status: Current

## Page Freeze

先判断是 renderer 还是 host：

1. 临时绕过页面进入时的 IPC。
2. 如果仍卡，优先查 renderer 主线程长任务。
3. 如果不卡，优先查 host command、payload 体积、锁竞争。

重点位置：

- `src/App.tsx`
- `src/bridge/ipcRenderer.ts`
- `src/runtime/runtimeEventStream.ts`
- `src-tauri/src/commands/*`
- `src-tauri/src/events/*`

## IPC Failure

- 看 bridge 是否走了 fallback。
- 看 command 是显式 Tauri command 还是兼容总线。
- 看 payload 是否过大。
- 看返回 shape 是否变化。

## Workspace/Data Mismatch

- 先查 `persistence/` 和 `workspace_loaders.rs`
- 再查 workspace 实际文件
- 最后查 renderer 是否错误假设字段一定存在

## Runtime Problems

- 看 `src-tauri/src/runtime/`
- 看 `src-tauri/src/events/README.md`
- 看 `src/runtime/runtimeEventStream.ts`
- 检查 sessionId、taskId、runtimeId 是否正确传递

### Runtime Perf Benchmark

开发者模式开启后，可在 `Settings -> Tools -> AI Runtime 性能测试` 里直接跑真实 benchmark。

推荐用法：

1. 先跑 `延迟冒烟`，确认 `thinking` 和首个 `response` 的时间。
2. 再跑 `工具探测`，确认 `tool-start / tool-end` 是否落地。
3. 最后看单轮时间线，定位卡在 phase、tool 还是 checkpoint。

这个模块会：

- 为每轮测试创建独立 session，避免历史上下文污染。
- 订阅统一 `runtime:event`，记录 phase、首 token、tool、checkpoint、done。
- 回读 `runtime diagnostics summary / checkpoints / tool results`，补齐 prompt chars、skill 数和持久化结果。

## Video Problems

- 先查 `src/components/manuscripts/`
- 再查 `src/features/video-editor/store/`
- 最后查 `src/remotion/` 与 [remotion/render.mjs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/remotion/render.mjs)

## Useful Commands

```bash
pnpm tauri:dev
pnpm build
pnpm ipc:inventory
cd src-tauri && cargo check
```
