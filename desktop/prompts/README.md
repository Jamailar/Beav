# `prompts/`

本目录存放 RedBox 运行时使用的提示词资产。

## Structure

- `library/`: 当前主要 prompt 资源
- 其他文件：历史或顶层提示词资源

## Rules

- 提示词是 AI 系统边界的一部分，不要把等效规则复制到宿主代码里。
- 新 prompt 应写清适用 runtime、输入契约和预期产出。
- 修改 prompt 后，应验证对应真实运行时行为。
