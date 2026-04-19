# `src/types/`

本目录存放 renderer 专用类型声明和第三方补充声明。

## Current Files

- `weixin-claw-core.d.ts`
- `ws.d.ts`

## Rules

- 只放 renderer 编译需要的声明，不放业务协议真相源。
- 共享协议优先放 `shared/`。
- 如声明影响运行时行为，必须同时补相应文档或代码注释。
