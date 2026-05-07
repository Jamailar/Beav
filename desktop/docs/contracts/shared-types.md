# Shared Types Contract

Status: Current

## Scope

本文件描述前后端共享但不直接放在 Rust `serde` 结构里的 TypeScript 协议，重点是 `shared/` 和 renderer 侧消费方式。

## Source Of Truth

- [shared/localAsset.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/shared/localAsset.ts)
- [shared/manuscriptFiles.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/shared/manuscriptFiles.ts)
- [shared/modelCapabilities.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/shared/modelCapabilities.ts)
- [shared/redboxVideo.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/shared/redboxVideo.ts)

## Main Contracts

### Local Asset URL

- 统一协议：`redbox-asset://asset/...`
- 兼容历史：`local-file://`、`file://`、绝对路径
- 使用场景：renderer 预览、素材引用、Remotion 渲染前的路径重写

### Manuscript Folder Projects

- Markdown：`.md`
- Package drafts：包含 `manifest.json` 的普通文件夹
- `manifest.packageKind` 决定稿件类型、编辑器能力和导出路径

### Model Capabilities

- capability：`chat`、`image`、`video`、`audio`、`transcription`、`embedding`
- input capability：`image`、`audio`、`video`、`file`
- 该层负责“模型能力发现”，而不是实际供应商请求执行

### Official Video Models

- `shared/redboxVideo.ts` 定义官方视频模式和模型映射
- renderer 和 host 都应依赖同一套模式名，不要各自硬编码

## Change Rules

- 改共享协议前，先搜索调用点。
- 如果协议影响持久化或 host payload，必须同步更新 `docs/contracts/workspace-schema.md` 或相关 Rust 文档。
- 新增共享协议时，优先放在 `shared/` 而不是 `src/utils/`。
