---
name: subtitles
---

# Subtitles

- 字幕、标题卡、屏幕文案要区分：
  - 字幕：跟随语音或片段节奏
  - 标题卡：独立 scene 或 overlay
  - 屏幕强调文案：overlay 或 text entity
- 需要字幕时，优先使用 overlay / text entity 的显式时间范围，不要把字幕需求误做成普通文字轨。
- 多段字幕时，逐段控制 `startFrame` 与 `durationInFrames`。
