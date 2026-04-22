---
description: 封面生成辅助技能。
allowedRuntimeModes: [redclaw]
allowedToolPack: redclaw
allowedTools: [bash, app_cli]
hookMode: inline
autoActivate: false
contextNote: 需要明确输出封面标题、构图与提示词。
---
# Cover Builder

用于把标题、平台调性和参考素材转成封面方案的内置技能。

## 输出要求

- 提供 3-5 个封面标题方案。
- 标注主视觉、构图、色彩、字体建议。
- 如果配置了图片生成 endpoint，优先生成真实封面资产；否则输出可执行的封面提示词。
