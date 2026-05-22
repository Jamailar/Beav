# `media_generation.rs`

媒体生成请求与结果处理模块。

- 图片/视频生成配置解析。
- 生成请求统一封装。
- 生成结果（URL/Base64）落盘与元信息提取。

运行时队列在 `media_runtime/mod.rs` 中统一管理。图片、视频、长视频拼接、TTS 音频、音频序列和资产库声音复刻分别使用 `image`、`video`、`video_sequence`、`audio`、`audio_sequence`、`voice_clone` job kind；provider 细节仍下沉到各自 adapter，例如 TTS/复刻由 `voice_service.rs` 执行。

统一队列 CRUD 入口走 `generation:*` IPC：提交按媒体类型映射为不同 `kind`，查询/等待/取消/重试/归档删除复用同一套 `media_jobs.sqlite` 表结构。删除采用 `archived_at` 软归档，避免正在执行的 worker 或 provider 回调因为物理删除而丢失回写与排障证据。

`generation:submit-video` 会在 `durationSeconds > 15` 或请求显式包含多个 `videoSegments` 时自动进入 `video_sequence`。该 job 在队列内逐段调用上游视频生成，每段保存为 `video_segment` artifact，最终用 ffmpeg 拼接为一个 `media` artifact 并注册到媒体库；用户侧只需要消费最终视频。

视频生成不做后台自动重试。单个视频尝试的运行超时时间是 30 分钟；提交、轮询、下载或长视频分段生成失败后直接进入失败态，由用户手动重试，避免昂贵的视频 API 因网络/未知错误被重复触发。
