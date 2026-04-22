# `prompts/library/runtime/advisors/`

这里放顾问/成员相关的 runtime prompt。

## Main Groups

- `generate_persona_*`: 画像研究与最终产出
- `optimize_*`: prompt 优化
- `reply_wrapper.txt`: 回复包装
- `templates/`: 模板化成员定义

## Rules

- 研究 prompt 和最终输出 prompt 分开维护。
- 模板角色定义优先放 `templates/`，不要把模板信息塞进系统 prompt 文本里。
