# Documentation Style

本文件约束仓库内开发文档的最小结构，目标是减少“有文档但不能维护”的情况。

## Status Labels

- `Current`: 当前维护入口，改动时必须同步
- `Reference`: 仍有价值，但不是唯一真相来源
- `Legacy`: 历史兼容说明，默认不作为新功能入口
- `Superseded`: 已被新文档替代，只保留历史背景

## Recommended Template

```md
# Title

Status: Current

## Scope
## Entry Points
## Responsibilities
## Data Flow
## Change Rules
## Verification
## Related Files
```

## Writing Rules

- 写代码真实结构，不写抽象口号。
- 只描述对维护者有帮助的信息，不写 PR 套话。
- 文档应该能回答：
  - 从哪里进入
  - 改这里会影响什么
  - 哪些文件是主入口
  - 哪些点最容易回归
  - 怎么验证
- 优先用路径、模块名、命令、数据结构说明，不要用模糊表述。

## Placement Rules

- 目录职责文档：放在目录旁边的 `README.md`
- 单文件复杂模块文档：放在同级 `模块名.README.md`
- 跨模块契约和流程：放在 `docs/`

## Update Triggers

出现以下任一情况时，必须回写文档：

- 新增目录级模块
- IPC / event / schema 发生变化
- 页面入口或数据流改变
- 调度、技能、工具、MCP 行为改变
- 修 bug 后沉淀出新的工程约束
