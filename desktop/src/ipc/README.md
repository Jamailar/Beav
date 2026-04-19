# `src/ipc/`

这里承载 renderer 启动期的 IPC 初始化。

## Entry Point

- [bootstrap.ts](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src/ipc/bootstrap.ts)

## Rule

- 启动期只做 bridge 安装和必要初始化，不要把业务逻辑堆到这里。
- 若需要更复杂的启动序列，优先拆回 `src/main.tsx` 或独立模块。
