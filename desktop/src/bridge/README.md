# `src/bridge/`

本目录是 renderer 到宿主的唯一推荐接入层。

## Entry Point

- [ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/ipcRenderer.ts)

## Module Layout

- [core.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/core.ts): IPC 内核，负责 Tauri command/channel 调用、监听注册、timeout、normalize、fallback 调度。
- [browserHost.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/browserHost.ts): 非 Tauri 浏览器宿主回退，负责把显式 command 映射到本地 HTTP host。
- [fallbacks.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/fallbacks.ts): 稳定 fallback response registry，页面不应各自猜空态结构。
- [types.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/types.ts): bridge core 与 listener/fallback 公共类型。
- [domains/](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/domains): 业务 facade，按能力域组织 `knowledge`、`generation`、`system` 等页面可用 API。

## Responsibilities

- 暴露 `window.ipcRenderer`
- 组合各 domain facade，保持 renderer 外部 API 稳定
- 统一处理 command/channel 路由、timeout、fallback、normalize
- 在 `core.ts` 维护少量显式 Tauri command 映射
- 收敛宿主能力入口，例如 `audio:*` 这类页面级共享能力

## Rules

- 新页面不要直接使用裸 `invoke` 或 `listen`
- 新 host 能力优先在 `domains/` 增加 typed facade，再由 `ipcRenderer.ts` 组合导出
- 新 fallback shape 统一加到 `fallbacks.ts`，避免页面自己猜
- `ipcRenderer.ts` 只做装配和暂未迁移 facade 的兼容承载，不再新增底层调用机制

## Verification

- 调用成功路径
- 超时路径
- 宿主报错路径
- 返回值归一化路径
