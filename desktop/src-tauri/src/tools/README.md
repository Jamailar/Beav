# tools 模块

第二阶段（Tool Registry + Tool Pack）落地模块。

## 职责

- `catalog.rs`：工具 descriptor 与 OpenAI schema 定义（kind / approval / concurrency / budget）。
- `compat.rs`：历史工具名兼容层，统一映射到通用 `redbox_*` 工具入口。
  - 兼容层应优先继续收敛到 canonical tools，而不是给 legacy tool 保持完整独立语义面。
- `packs.rs`：`runtimeMode -> tool pack` 映射，以及 pack 允许的工具集合。
- `registry.rs`：按 mode 提供工具列表、schema 列表和提示词可读描述。
- `guards.rs`：执行前工具准入校验与 `ToolResultBudget` 截断策略。

## 约束

- 前端/Prompt 只消费 registry 输出，不直接拼工具清单。
- 运行时执行工具前必须走 guard，禁止越权调用不在 pack 内的工具。
- 通用工具收敛到：
  - `bash`
  - `redbox_fs`
  - `app_cli`
  - `redbox_editor`（仅编辑器 runtime）
- 兼容层保留：
  - `redbox_app_query`
  - `redbox_profile_doc`
  - `redbox_mcp`
  - `redbox_skill`
  - `redbox_runtime_control`

## 治理规则

- 顶层工具优先保持在少量通用入口，不按主题、模板、稿件、profile、MCP、skill、runtime 等领域继续拆新的顶层工具。
- 如果能力只是作用域不同、文件不同、业务子域不同，优先扩已有工具的 `action` / typed payload，而不是新增 sibling tool。
- 文件相关能力优先收敛到 `redbox_fs`，不要继续保留或新增大量 `*_glob` / `*_grep` / `*_read` 一类领域文件工具。
- 宿主业务能力优先收敛到 `app_cli`，不要把查询、profile、MCP、skill、runtime control 再拆成独立产品级工具面。
- `app_cli` 内部优先用清晰 namespace 组织：例如 `advisors`、`chat sessions`、`manuscripts theme/layout`、`runtime`、`skills`、`ai`、`mcp`。可以扩子命令，但不要回退到新的顶层工具。
- 编辑器原生协议只放在 `redbox_editor`。编辑器内部可以有动作分组，但不要把 UI 面板或模板类型直接映射成新的顶层工具。
- compatibility alias 只用于迁移，不是长期治理边界。新 prompt、skill、pack、runtime metadata 一律使用 canonical tool names。
- 任何新工具都必须先回答一个问题：`bash`、`redbox_fs`、`app_cli`、`redbox_editor` 为什么不能安全清晰地表达这件事；回答不出来，就不要新增。

## 当前 Canonical 规则

- 顶层 tool 固定为：`bash`、`redbox_fs`、`app_cli`、`redbox_editor`。
- LLM 真正选择的原子能力是 `action`，不是顶层 tool 名。
- 新能力优先新增 canonical action，不再新增 legacy tool alias。
- prompt / skill / runtime metadata 只允许引用 canonical tool 名和 canonical action；不要再写 `app_cli(command="...")`、`knowledge_read`、`knowledge_grep`、`redbox_runtime_control` 这类历史语法。

## Action Contract

- 每个 action 必须单一职责，名字直接表达一个结构化能力。
- schema-first：action 必须有明确输入 schema 和输出 schema。
- `app_cli` / `redbox_fs` / `redbox_editor` 一律优先走 `action + payload` 协议。
- `redbox_fs` 的 canonical action 固定为：
  - `workspace.list`
  - `workspace.read`
  - `workspace.search`
  - `knowledge.list`
  - `knowledge.read`
  - `knowledge.search`
- `redbox_editor` 的运行时 schema 走 `action + payload`；兼容层可以把旧的扁平字段整理成 canonical 形态，但新资产不要再依赖旧写法。

## 输出与兼容

- 工具返回值默认使用结构化 envelope：成功返回 `ok=true`，失败返回 `ok=false` 和结构化 `error.code / error.message / error.retryable`。
- 能补 `tool` 和 `action` 的结果，一律补齐，方便诊断和 UI 展示。
- `compat.rs` 只做翻译，不承载新的产品语义。
- legacy 调用可以继续被翻译，但只能视为迁移输入，不能再作为文档推荐写法。
