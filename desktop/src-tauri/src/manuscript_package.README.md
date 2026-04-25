# `manuscript_package.rs`

稿件工程模块。

当前支持两类稿件工程：

- `*.redpost`：面向图文稿件，正文始终以 Markdown 为真相层，宿主按需维护对应的主题、预览和导出资产。
- `*.redarticle`：面向长文稿件，正文以 Markdown 为真相层，并可生成阅读页或公众号适配结果。

## 工程文件结构

### 图文工程 `*.redpost`

- `manifest.json`
- `content.md`
- `content-map.json`
- `layout.tokens.json`
- `layout.html`
- `masters/`
- `pages/`
- `themes/`
- `cover.json`
- `images.json`
- `assets.json`

说明：

- `content.md` 是正文唯一真相层。
- 图文主题、预览和导出相关文件都属于宿主管理资产，按需生成与刷新。
- 渲染产物只用于展示与导出，不作为正文编辑入口。

### 长文工程 `*.redarticle`

- `manifest.json`
- `content.md`
- `layout.html`
- `wechat.html`
- `cover.json`
- `images.json`
- `assets.json`

## 正式链路

### 图文工程 `*.redpost`

1. Markdown 是正文唯一来源。
2. 保存正文时，宿主会同步刷新结构化映射与必要的渲染资产。
3. 图文主题与视觉层由宿主管理，正文编辑和视觉资产始终分层。
4. 需要更新图文预览或导出素材时，应优先走宿主命令刷新，而不是把渲染产物当真相层。
5. 主题切换和样式调整只影响视觉层，不直接改写正文。

### 长文工程 `*.redarticle`

1. Markdown 仍然是正文源。
2. 长文样式由 `manifest` 里的版式配置控制。
3. `layout.html` / `wechat.html` 由宿主或对应渲染链路生成。
4. 正文与最终渲染结果保持分层，避免把 HTML 当成正文真相层。

## 模块职责

### 宿主

- `src-tauri/src/commands/manuscripts.rs`
  负责正文保存、结构化映射刷新、样式资产维护、页面渲染与导出相关写回。
- `src-tauri/src/manuscript_package.rs`
  负责读取稿件工程状态，并把宿主管理的结构化信息与渲染资产暴露给前端。
- `src-tauri/src/helpers.rs`
  负责稿件工程路径约定与宿主管理资产定位。

### AI

- 长文 HTML 渲染仍由对应模板与约束文件驱动。
- 图文相关 AI 约束只应处理视觉层或宿主管理资产，不应绕过宿主直接改写正文真相层。

### 前端

- `src/pages/Manuscripts.tsx`
  负责生成入口、保存联动和包状态刷新。
- `src/components/manuscripts/WritingDraftWorkbench.tsx`
  负责图文与长文预览容器。

## 宿主命令

- 稿件创建、保存、渲染、主题、预览、导出等命令统一维护在 `src-tauri/src/commands/manuscripts.rs`。
- 兼容旧链路的命令仍可保留，但新的工程行为应以当前宿主管理资产链路为准。

## 触发规则

- 新建稿件工程时，先落最小骨架文件。
- 首次保存正文或首次进入需要预览的编辑态时，由宿主按需补齐结构化映射与渲染资产。
- 图文主题、图文预览、长文渲染、导出文件等，都通过宿主刷新，不由正文编辑直接手写产物。
- 正文内容变更时，只更新正文真相层及其直接依赖资产；视觉层配置保持独立。

## 性能策略

- 正文保存优先走本地结构化刷新与必要的渲染更新，不把渲染链路耦合成一次大模型调用。
- 渲染资产按需生成，避免在新建工程时一次性写满全部辅助文件。
- 前端预览直接消费宿主管理的真实文件，避免在渲染层重复拼接大块字符串。
