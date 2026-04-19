# `src/vendor/freecut/`

这是 vendored 的 FreeCut 代码根目录。

## Purpose

- 为 RedBox 提供时间线和编辑器相关基础能力
- 保持接近上游结构，降低后续同步成本

## Existing Local Docs

- [ATTRIBUTION.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src/vendor/freecut/ATTRIBUTION.md)
- `infrastructure/README.md`
- `shared/README.md`
- `shared/state/README.md`
- [docs/freecut-vendoring.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/docs/freecut-vendoring.md)

## Maintenance Rule

- vendored 根目录以下的细分子目录默认沿用上游结构，不要求为每个叶子目录单独补本仓库维护文档。
- RedBox 自己的业务适配应尽量放在外层桥接文件，而不是直接侵入 vendored 深层实现。
