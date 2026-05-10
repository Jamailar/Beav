# `media_generation.rs`

媒体生成请求与结果处理模块。

- 图片/视频生成配置解析。
- 生成请求统一封装。
- 生成结果（URL/Base64）落盘与元信息提取。

运行时队列在 `media_runtime/mod.rs` 中统一管理。图片、视频、TTS 音频和资产库声音复刻分别使用 `image`、`video`、`audio`、`voice_clone` job kind；provider 细节仍下沉到各自 adapter，例如 TTS/复刻由 `voice_service.rs` 执行。
