# Frontend Development Guide

Status: Current

## Scope

适用于 `src/` 下的 renderer 页面、组件、bridge 消费和局部状态维护。

## Entry Points

- `src/main.tsx`
- `src/App.tsx`
- `src/pages/`
- `src/components/`
- `src/bridge/ipcRenderer.ts`
- `src/runtime/runtimeEventStream.ts`

## Rules

- 页面显示优先，host 数据后台加载。
- 不要在页面切换时等待慢 IPC 再渲染页面壳。
- 刷新时保留已有内容，只显示局部刷新态。
- 通过 bridge 统一做 timeout、fallback、normalize。
- 不要在 render 阶段假设嵌套字段一定存在。

## Where To Put Logic

- 页面级编排：`src/pages/`
- 跨页面复用组件：`src/components/`
- 视频编辑等垂直功能：`src/features/`
- runtime event 消费：`src/runtime/`
- host 接入 facade：`src/bridge/`
- 启动期初始化：`src/ipc/bootstrap.ts`

## Common Verification

- 页面切换是否立即可点击
- IPC 超时后是否回退到安全默认值
- 旧数据是否在刷新失败时仍保留
- runtime 事件是否按 session/task 正确过滤
- 大列表或编辑器是否引入明显卡顿
