# tools 模块

第二阶段（Tool Registry + Tool Pack）落地模块。

## 职责

- `catalog.rs`：工具 descriptor 与 OpenAI schema 定义（kind / approval / concurrency / budget）。
- `compat.rs`：模型可见工具到内部 canonical action 的窄映射层，不再接受历史 legacy tool alias。
- `packs.rs`：`runtimeMode -> tool pack` 映射，区分模型可见工具集合和内部执行工具集合。
- `registry.rs`：按 mode 提供模型可见工具列表、schema 列表和提示词可读描述。
- `guards.rs`：执行前工具准入校验与 `ToolResultBudget` 截断策略。

## 约束

- 前端/Prompt 只消费 registry 输出，不直接拼工具清单。
- 运行时执行工具前必须走 guard，禁止越权调用不在 pack 内的工具。
- 模型可见工具收敛到 Claude/Codex 风格原语：
  - `Read`
  - `List`
  - `Search`
  - `Write`
  - `Operate`
  - `bash`
  - `tool_search`
- 内部执行工具继续收敛到：
  - `bash`
  - `resource`
  - `workflow`
  - `editor`（仅编辑器 runtime）
- 兼容层不再接受 `query`、`profile_doc`、`mcp`、`skill`、`runtime_control` 等历史 alias。

## 治理规则

- 顶层模型工具优先保持为少量通用入口，不按主题、模板、稿件、profile、MCP、skill、runtime 等领域继续拆新的模型可见工具。
- 如果能力只是作用域不同、文件不同、业务子域不同，优先用虚拟路径表达，例如 `workspace://`、`knowledge://`、`manuscripts://`、`profiles://`、`editor://current/script`。
- 文件和知识读取优先通过 `Read` / `List` / `Search`，内部再映射到 `resource`；不要继续保留或新增大量 `*_glob` / `*_grep` / `*_read` 一类模型可见工具。
- 宿主业务能力优先通过 `Operate(resource, operation, input)`，内部再映射到 `workflow`；不要把查询、profile、MCP、skill、runtime control 再拆成独立产品级工具面。
- 编辑器原生协议优先通过 `Read` / `Write` / `Operate(resource="editor", ...)`，内部再映射到 `editor`。编辑器内部可以有动作分组，但不要把 UI 面板或模板类型直接映射成新的模型可见工具。
- compatibility alias 已从主执行路径硬切移除。新 prompt、skill、pack、runtime metadata 一律使用模型可见工具名或内部 canonical action。
- 任何新模型可见工具都必须先回答一个问题：`Read`、`List`、`Search`、`Write`、`Operate`、`bash`、`tool_search` 为什么不能安全清晰地表达这件事；回答不出来，就不要新增。

## 当前 Canonical 规则

- 模型可见 tool 固定为：`Read`、`List`、`Search`、`Write`、`Operate`、`bash`、`tool_search`。
- 内部 canonical tool 固定为：`bash`、`resource`、`workflow`、`editor`。
- LLM 优先选择熟悉的通用原语；业务动作只通过 `Operate(resource, operation, input)` 暴露。
- `tool_search` 只用于查找 deferred action / MCP tool，不再通过 `Operate(resource="tools", operation="search")` 暴露重复入口。
- 新能力优先新增内部 canonical action 或虚拟路径 resolver，不再新增 legacy tool alias。
- prompt 只引用模型可见工具名；runtime metadata 的 `allowedTools` 只写内部 canonical 名。不要再写 `workflow(command="...")`、`knowledge_read`、`knowledge_grep`、`runtime_control` 这类历史语法。

## Action Contract

- 每个 action 必须单一职责，名字直接表达一个结构化能力。
- schema-first：action 必须有明确输入 schema 和输出 schema。
- `Read` / `List` / `Search` / `Write` 使用虚拟路径协议。
- `Operate` 使用 `resource + operation + id? + input?` 协议。
- `Operate(resource="image", operation="generate")` 的比例、尺寸、质量必须放在 `input.aspectRatio` / `input.size` / `input.quality`，不要只写进自然语言 prompt。支持的 `aspectRatio` 为 `1:1`、`3:4`、`4:3`、`9:16`、`16:9`。
- `workflow` / `resource` / `editor` 作为内部执行层，仍一律优先走 `action + payload` 协议。
- 虚拟路径示例：
  - `workspace://README.md`
  - `knowledge://api-guidelines.md`
  - `manuscripts://current`
  - `profiles://creator_profile`
  - `editor://current/script`
- `resource` 的 canonical action 固定为：
  - `workspace.list`
  - `workspace.read`
  - `workspace.createDirectory`
  - `workspace.write`
  - `workspace.search`
  - `knowledge.list`
  - `knowledge.read`
  - `knowledge.attach`
  - `knowledge.search`
- `knowledge.attach` 只负责把知识库里的图片 / 音频 / 视频文件登记为下一轮模型输入附件；是否真正直传由 runtime 按当前 provider / model 能力判断，不支持时必须降级为文字说明。
- `knowledge.search` 在 indexed knowledge scope 下应返回结构化 `queryProfile` / `queryPlan` / `evidencePack`；这不仅包括 document source，也包括 advisor/member knowledge。
- `editor` 的运行时 schema 走 `action + payload`；兼容层可以把旧的扁平字段整理成 canonical 形态，但新资产不要再依赖旧写法。

## 输出与兼容

- 工具返回值默认使用结构化 envelope：成功返回 `ok=true`，失败返回 `ok=false` 和结构化 `error.code / error.message / error.retryable`。
- 能补 `tool` 和 `action` 的结果，一律补齐，方便诊断和 UI 展示。
- `compat.rs` 只做翻译，不承载新的产品语义。
- legacy 调用一律返回结构化错误，让模型改用 `Read` / `List` / `Search` / `Write` / `Operate`。
