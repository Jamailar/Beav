# tools 模块

第二阶段（Tool Registry + Tool Pack）落地模块。

## 职责

- `catalog.rs`：工具 descriptor 与 OpenAI schema 定义（kind / approval / concurrency / budget）。
- `compat.rs`：历史工具名兼容层，统一映射到通用 `redbox_*` 工具入口。
- `packs.rs`：`runtimeMode -> tool pack` 映射，以及 pack 允许的工具集合。
- `registry.rs`：按 mode 提供工具列表、schema 列表和提示词可读描述。
- `guards.rs`：执行前工具准入校验与 `ToolResultBudget` 截断策略。

## 约束

- 前端/Prompt 只消费 registry 输出，不直接拼工具清单。
- 运行时执行工具前必须走 guard，禁止越权调用不在 pack 内的工具。
- 通用工具收敛到：
  - `redbox_app_query`
  - `redbox_fs`
  - `redbox_profile_doc`
  - `redbox_mcp`
  - `redbox_skill`
  - `redbox_runtime_control`
