# `prompts/library/`

这是当前主要 prompt 资产库，覆盖基础链路、runtime 子域、persona、template 等。

## Main Groups

- 顶层基础链路：`intent.txt`、`planner.txt`、`executor.txt`、`validator.txt`、`synthesizer.txt`
- `runtime/`: runtime 子域 prompt
- `personas/`: 角色人格提示词
- `templates/`: 结构化生成模板

## Rules

- 新增 prompt 前先确认它属于：
  - 路由/规划
  - runtime 子能力
  - persona
  - 模板输出
- 同一能力不要在多个 prompt 文件里复制规则。
- 改 prompt 后至少验证一次真实调用链。
