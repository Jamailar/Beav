# `src/bridge/`

本目录是 renderer 到宿主的唯一推荐接入层。

## Entry Point

- [ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src/bridge/ipcRenderer.ts)

## Responsibilities

- 暴露 `window.ipcRenderer`
- 统一处理 command/channel 路由
- 提供 timeout、fallback、normalize
- 维护少量显式 Tauri command 映射

## Rules

- 新页面不要直接使用裸 `invoke` 或 `listen`
- 新 host 能力优先在这里加 typed facade
- fallback shape 必须稳定，避免页面自己猜

## Verification

- 调用成功路径
- 超时路径
- 宿主报错路径
- 返回值归一化路径
