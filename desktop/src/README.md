# `src/` Renderer

本目录是 RedBox 的 React renderer，实现页面、组件、bridge 消费和运行时事件 UI。

## Entry Points

- [main.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src/main.tsx)
- [App.tsx](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src/App.tsx)

## Key Subdirectories

- `pages/`: 页面级产品表面
- `components/`: 复用组件和编辑器组件
- `features/`: 垂直功能模块
- `bridge/`: `window.ipcRenderer` facade
- `ipc/`: 启动期 bridge 安装
- `runtime/`: runtime event 消费
- `types/`: renderer 专用类型声明
- `remotion/`: Remotion 根组件入口

## Change Rules

- 页面切换优先渲染，再后台请求 host 数据。
- renderer 不直接散落 `invoke/listen`，统一走 bridge。
- 新的复杂页面先放 `pages/`，共性稳定后再提取到 `components/` 或 `features/`。

## Verification

- 打开对应页面
- 切换时无阻塞
- 刷新失败不清空旧数据
