# `manuscript_package.rs`

稿件工程模块。

当前支持的文字稿件工程：

- `*.thrive`：统一自定义单文件容器。当前已启用 `kind=post`，正文以 Markdown 为真相层，配图、平台、帖子和来源关系写入 `bindings.json`。
- `*.redarticle`：面向长文稿件，正文以 Markdown 为真相层。

## 工程文件结构

### Post 工程 `*.thrive`

`.thrive` 是 ZIP 容器，内部最小结构：

- `manifest.json`
- `content.md`
- `bindings.json`
- `variants/`（可选）

说明：

- `content.md` 是正文唯一真相层。
- `bindings.json` 保存媒体、目标平台、已发布帖子、来源和灵感绑定。
- `variants/<platform>.md` 保存平台微调版本；没有 variant 时使用 `content.md`。
- Post 不再维护图文分页、主题、HTML 预览和导出渲染资产。

### 长文工程 `*.redarticle`

- `manifest.json`
- `content.md`
- `cover.json`
- `images.json`
- `assets.json`

## 正式链路

### Post 工程 `*.thrive`

1. Markdown 是正文唯一来源。
2. 保存正文时，宿主更新 ZIP 内的 `content.md`，并保留 `bindings.json` 与 `variants/`。
3. 配图通过媒体库 id 写入 `bindings.media`，默认不复制媒体文件。
4. 平台目标写入 `bindings.targets`，发布后的真实帖子写入 `bindings.publishedPosts`。
5. 平台微调写入 `variants/<platform>.md`，不直接污染母稿。

### 长文工程 `*.redarticle`

1. Markdown 是唯一维护内容。

## 模块职责

### 宿主

- `src-tauri/src/commands/manuscripts.rs`
  负责正文保存、post bindings、平台 variant，以及仍未迁移类型的样式资产维护。
- `src-tauri/src/manuscript_package.rs`
  负责读取稿件工程状态，并把宿主管理的结构化信息与渲染资产暴露给前端。
- `src-tauri/src/helpers.rs`
  负责稿件工程路径约定与宿主管理资产定位。

### 前端

- `src/components/manuscripts/WritingDraftWorkbench.tsx`
  负责正文编辑和当前稿件 AI 对话。

## 宿主命令

- 稿件创建、保存、post bindings、平台 variants、渲染、主题、预览、导出等命令统一维护在 `src-tauri/src/commands/manuscripts.rs`。
- 兼容旧链路的命令仍可保留，但新的工程行为应以当前宿主管理资产链路为准。

## 触发规则

- 新建稿件工程时，先落最小骨架文件。
- 首次保存正文或首次进入需要预览的编辑态时，由宿主按需补齐结构化映射与渲染资产。
- Post 只更新正文、bindings 和 variants；长文渲染、导出文件等仍通过宿主刷新，不由正文编辑直接手写产物。
- 正文内容变更时，只更新正文真相层及其直接依赖资产；视觉层配置保持独立。

## 性能策略

- 正文保存优先走本地结构化刷新与必要的渲染更新，不把渲染链路耦合成一次大模型调用。
- 渲染资产按需生成，避免在新建工程时一次性写满全部辅助文件。
- 前端预览直接消费宿主管理的真实文件，避免在渲染层重复拼接大块字符串。
