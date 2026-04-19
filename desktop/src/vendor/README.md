# `src/vendor/`

本目录用于放 vendored 第三方代码，不把第三方实现直接散落在业务目录中。

## Current Area

- `freecut/`: 已 vendored 的时间线与编辑器相关代码

## Rules

- 第三方代码来源、许可、上游关系必须在 vendored 目录内写清楚。
- 业务适配优先放桥接层，不要直接在 vendored 代码里堆业务判断。
- 升级或同步上游时，先看 [docs/freecut-vendoring.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/docs/freecut-vendoring.md)
