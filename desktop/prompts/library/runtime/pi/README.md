# `prompts/library/runtime/pi/`

这里放与编辑器/创作工作台相关的基础系统 prompt。

## Current Files

- `system_base.txt`
- `manuscript_editor.txt`
- `audio_editor.txt`
- `video_editor.txt`

## Rules

- `system_base` 放共性原则。
- 稿件编辑页的纯改稿行为放 `manuscript_editor`，保持工具面和提示词最小。
- 音频、视频的专属行为放各自文件，不在单一大 prompt 中混写。
