# `prompts/library/runtime/redclaw/`

这里放 RedClaw 的运行时 prompt，包括定时任务、长周期任务和平台内容生成。

## Main Groups

- 调度默认：`scheduled_default.txt`、`runner_run_now_default.txt`
- 长周期：`long_cycle_default.txt`、`long_cycle_task.txt`
- 内容生成：`write_xiaohongshu.txt`、`write_wechat_article.txt`
- 平台转换：`expand_xhs_to_wechat.txt`

## Rules

- 任务调度 prompt 和内容创作 prompt 分开维护。
- 平台转换规则优先写在这里，不要散落到页面文案或命令层。
