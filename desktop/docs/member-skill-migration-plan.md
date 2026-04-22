# 成员技能化与知识检索迁移计划

更新时间：2026-04-18

## 1. 文档目标

本文定义 LexBox 当前 `advisor + knowledge + skills + runtime + tools` 体系向“成员技能化系统”迁移的完整计划。

目标不是一次性推翻现有实现，而是在现有骨架上逐步升级为：

- 先把知识库文件检索与索引底座打稳，让知识页和后续检索不再依赖全量文件扫描
- 每个成员都可被蒸馏为一个可落盘、可版本化的 `Member Skill Package`
- 每个成员都能基于自己的知识库进行语言感知检索
- 每个成员不仅能发言，还能在明确边界内调用工具执行动作
- 每一阶段上线后都具备明确的性能收益、验收标准、风险边界和回滚路径

本文是执行计划，不是概念说明。默认按“逐步迁移、逐步调试、逐步扩大灰度”执行。

## 2. 当前系统基础

当前仓库已经具备迁移所需的关键基础设施：

- 技能运行时已经是一等对象，而非静态 prompt 片段：`docs/skill-runtime-v2.md`
- 知识库写入已是 workspace-first：`src-tauri/src/knowledge.rs`
- advisor 已有 `personality / system_prompt / knowledge_language / knowledge_files` 数据结构：`src-tauri/src/commands/advisor_ops.rs`
- runtime 上下文已改为 section-based context bundle：`docs/runtime-context-bundle.md`
- 技能可影响工具可见性与运行时 capability set：`src-tauri/src/skills/runtime.rs`、`src-tauri/src/skills/permissions.rs`
- 工具调用已有 guardrails 与 audit：`docs/runtime-capability-guardrails.md`

当前缺失的系统层能力主要有：

- 知识库页面与知识检索仍缺少稳定的文件索引/catalog 层
- 自动语言识别尚未成为知识库 ingest 的统一元数据层
- advisor 的 persona 仍偏向“单段 prompt 产物”，不是“可编译技能包”
- 成员知识检索缺少语言感知与成员作用域路由
- 成员工具权限仍主要依附 runtimeMode/tool pack，而非成员本体
- 缺少“新知识 -> 蒸馏候选 -> 成员技能版本升级”的闭环

## 3. 最终目标架构

迁移完成后，每个成员应具备以下统一结构：

```text
Member Skill Package
├── SKILL.md
├── member.json
├── persona.json
├── heuristics.jsonl
├── workflow.json
├── retrieval_scope.json
├── tool_policy.json
├── references/
├── examples/
└── scripts/
```

其中：

- `SKILL.md`
  - 运行时入口
  - 仅保留 Identity、核心规则、沟通风格、决策风格、工具摘要、检索说明
- `member.json`
  - 成员基础元数据、版本、来源、更新时间
- `persona.json`
  - 风格参数、态度张力、解释倾向、回答密度
- `heuristics.jsonl`
  - 决策启发式、问题拆解模式、判断顺序、反模式
- `workflow.json`
  - SOP、步骤图、常见任务的稳定执行路径
- `retrieval_scope.json`
  - 检索域、语言优先级、成员/项目/团队作用域过滤规则
- `tool_policy.json`
  - 允许工具、禁用工具、审批等级、工具优先顺序

## 4. 总体迁移原则

### 4.1 基本原则

- 先兼容旧 `advisor` 体系，再逐步内化成 `member package`
- 先做“文件检索底座”和“知识索引”，再做“语言与作用域检索”，最后才做“成员技能化”
- 先让系统“查得快、查得稳”，再让成员“像这个人”，最后让成员“能安全地做事”
- 弃用向量嵌入作为知识检索主路径；embedding/similarity 模块可以暂时保留，但不再作为默认方案推进
- 检索底座优先走“agent 自主调用搜索工具”的模式，不先做系统主导的重型检索编排器
- 系统负责知识范围、权限、索引、性能和安全边界；agent 负责决定先搜什么、再读什么、最后引用什么
- 运行时优先暴露小而清晰的原子工具，而不是把检索决策硬编码进宿主

### 4.1.1 向量嵌入弃用策略

当前对 embedding / similarity 的处理原则如下：

- **模块保留，但默认弃用**
  - 现有 `embedding:*`、`similarity:*`、相关 settings 和 cache 结构可以保留，避免一次性大删导致兼容回归
  - 这些模块不再作为知识检索、成员检索、智囊团发言、runtime 检索的默认依赖
- **禁止后台自动嵌入**
  - 不允许 watcher、catalog rebuild、workspace hydration、knowledge ingest、background task、daemon、cron 自动触发 embedding 计算
  - 文件新增、修改、删除只更新 catalog / file index，不更新向量缓存
- **禁止主流程隐式调用**
  - advisor 单聊、creative chat、chatrooms、member runtime、knowledge tools 不得隐式走向量相似度排序
  - 成员知识检索统一走 `knowledge_glob / knowledge_grep / knowledge_read`
- **只允许显式、受控、非主路径调用**
  - 若某个旧功能仍保留 embedding 能力，必须满足“显式触发、可关闭、非后台、非默认开启”
  - 默认 feature flag 应关闭，且不得影响成员发言与知识检索主链路
- **后续清理策略**
  - 在确认没有运行时主依赖后，再决定是否删除 host command、bridge、settings、cache 和文档残留
  - 在删除前，文档中一律按“已弃用但保留模块”表述，不再按“推荐能力”表述

### 4.2 迁移顺序

建议顺序如下：

1. 阶段 0：基线与观测补全
2. 阶段 1：文件索引与知识页检索底座
3. 阶段 2：语言元数据与语言感知检索
4. 阶段 3：蒸馏技能与成员技能包落盘
5. 阶段 4：成员技能包接入运行时
6. 阶段 5：成员工具能力成员化
7. 阶段 6：持续蒸馏与自动更新闭环

### 4.3 灰度与开关

每阶段必须挂 feature flag：

- `knowledgeCatalogIndex`
- `knowledgeLazyDetail`
- `languageAwareKnowledgeRetrieval`
- `memberSkillDistillation`
- `autoKnowledgeLanguageDetection`
- `memberRuntimeOverlay`
- `memberToolPolicy`
- `memberSkillAutoRefresh`

启用顺序：

1. diagnostics only
2. 单成员灰度
3. advisor 单聊
4. creative chat / advisor discussion
5. 默认开启

## 5. 核心子系统设计

### 5.1 Knowledge Catalog Index

新增知识索引子系统：

- `src-tauri/src/knowledge_index/*`

职责：

- 维护本地 `catalog index`
- 将 knowledge 文件系统视图投影为可分页、可筛选、可排序的 summary 层
- 监听文件变更并自动重建受影响项
- 支持知识页首屏、agent 搜索工具和后续运行时证据定位复用

关键约束：

- 只做文件/元数据索引，不把本阶段扩展成全文索引
- 正文、字幕、HTML、图片等 detail 内容按需读取
- workspace 文件/JSON 继续作为真相层
- catalog 的职责是“帮助 agent 快速定位候选文件”，不是替 agent 直接完成最终检索决策

建议的 catalog 记录字段：

- `item_id`
- `workspace_id`
- `kind`
- `title`
- `author`
- `source_url`
- `folder_path`
- `root_path`
- `preview_text`
- `language`
- `tags_json`
- `sample_files_json`
- `file_count`
- `has_video`
- `has_transcript`
- `updated_at`
- `item_hash`
- `scope`
- `owner_type`
- `owner_id`

其中新增的 `scope / owner_type / owner_id` 是后续“成员作用域搜索”的关键基础字段。

### 5.2 Member Distillation

新增内置技能：

- `builtin-skills/member-skill-distiller/SKILL.md`

职责：

- 读取成员知识文件、历史对话、历史样例、会议转写、规则文档
- 抽取：
  - Work Skill
  - Persona
  - Decision Heuristics
  - Workflow
  - Retrieval Scope
  - Tool Policy Draft
- 输出结构化技能包草案

注意：

- 技能负责“抽取与组织建议”
- 真正落盘、校验、版本升级、覆盖保护由 Rust host command 执行
- 不允许模型直接绕过 host 任意写文件

### 5.3 Language Detection

知识库语言识别不应再依赖手动填写。

推荐实现：

- Rust 侧离线识别，首选 `lingua-rs`
- 转写链路仍保留 Whisper 的 `auto-detect`
- 宿主统一维护语言元数据，不把 Whisper 的 UI 设置直接当知识语言真相源

语言识别粒度：

- `document_language`
- `chunk_language`
- `corpus_primary_language`
- `corpus_secondary_languages`
- `mixed_language`
- `language_confidence`

### 5.4 Retrieval

本计划的检索路线改为：

**系统提供成员作用域的搜索底座，agent 自主调用搜索工具完成检索。**

不采用的路线：

- 宿主在阶段 1 里直接替 agent 完成复杂多段重排
- 宿主在阶段 1 里直接引入全文索引 / chunk 检索 / vector lane
- 宿主在成员检索主流程中隐式调用 embedding / similarity

阶段 1 推荐形态：

- `knowledge_glob`
  - 在成员可见知识范围内按文件名、路径、kind、tag 查找候选文件
- `knowledge_grep`
  - 在成员可见知识范围内按 catalog 字段做内容搜索
  - 当前只搜 `title / preview / tags / sample_files / path`
- `knowledge_read`
  - 按需读取单个知识项详情
  - 对 note 读 `content.md / transcript / html`
  - 对 video 读 `summary / subtitle`
  - 对 docs source 读 source summary 和必要的 sample file

运行时职责边界：

- **系统负责**
  - 成员知识边界
  - catalog 索引
  - 候选文件的权限过滤
  - 返回结果条数限制
  - 文件读取与截断
  - 超时和错误处理
- **agent 负责**
  - 先调用 `glob` 还是 `grep`
  - 搜什么词
  - 要不要继续 `read`
  - 哪些文件最终值得引用

阶段 2 才引入：

- query language 检测
- `language_match_score`
- 成员 / 项目 / 团队 / 全局作用域权重
- 必要时的 FTS / semantic lane

这意味着前两阶段的检索主链路是：

```text
用户问题
-> 当前 advisor/member 已知
-> agent 调用 knowledge_glob / knowledge_grep 缩小范围
-> agent 调用 knowledge_read 打开少量文件详情
-> agent 基于结果发言
```

而不是：

```text
用户问题
-> 宿主自动重排全库
-> 宿主自动提取证据
-> 再把结果塞给 agent
```

这样做的原因：

- 更贴近 Claude Code 一类 agent 的工作方式
- 更容易调试 agent 到底为什么搜某个文件
- 宿主责任更清晰，只做底座和边界
- 阶段 1 的工程复杂度明显更低

### 5.5 Tool Policy

每个成员技能包必须自带工具边界：

- 允许工具
- 禁用工具
- 审批级别
- 优先工具顺序
- 只读 / 轻写 / 高风险分类

不允许成员默认拿到全量 MCP 权限。

## 6. 阶段计划

## 阶段 0：基线与观测补全

### 目标

先把当前系统行为测清楚，为后续每一阶段提供对照基线。

### 变更范围

- 为 advisor 生成 persona、knowledge ingest、runtime query、skills invoke、tool call 增加 timing 与 audit
- diagnostics 展示：
  - 平均 prompt chars
  - active skill 数
  - 检索耗时
  - 检索命中来源
  - 工具调用成功率
  - advisor 生成 persona 的耗时

### 主要改动文件

- `src-tauri/src/commands/advisor_ops.rs`
- `src-tauri/src/commands/runtime_query.rs`
- `src-tauri/src/skills/runtime.rs`
- `src-tauri/src/tools/guards.rs`
- diagnostics 对应前端面板

### 性能目标

- 埋点本身增加的单轮额外耗时 `< 10ms`

### 验收标准

- 能按 `advisorId` 看到：
  - persona 生成平均耗时
  - 平均 prompt chars
  - 平均检索耗时
  - 工具调用成功率
- diagnostics 面板中能看到最近 100 次的分布

### 回滚条件

- 若埋点导致明显交互卡顿或日志污染，关闭 diagnostics flag 即回退

## 阶段 1：文件索引与知识页检索底座

### 目标

先把知识库从“页面打开时扫目录、读正文、拼全量对象”升级成“索引驱动的 catalog 视图”，并在此基础上提供一组可供 agent 自主调用的成员作用域搜索工具。这是后续语言感知检索和成员技能化的底层前提。

### 交付物

- 新增本地索引模块：
  - `src-tauri/src/knowledge_index/mod.rs`
  - `src-tauri/src/knowledge_index/schema.rs`
  - `src-tauri/src/knowledge_index/catalog.rs`
  - `src-tauri/src/knowledge_index/indexer.rs`
  - `src-tauri/src/knowledge_index/jobs.rs`
  - `src-tauri/src/knowledge_index/watcher.rs`
  - `src-tauri/src/knowledge_index/fingerprint.rs`
- 新命令：
  - `knowledge:list-page`
  - `knowledge:get-item-detail`
  - `knowledge:get-index-status`
  - `knowledge:rebuild-catalog`
- 新增 agent-facing 检索工具命令：
  - `knowledge:glob`
  - `knowledge:grep`
  - `knowledge:read`
- 新索引文件：
  - `workspace/.redbox/index/knowledge_catalog.sqlite`

### 功能内容

1. 首屏列表只读取 catalog summary，不读取正文全文
2. note / YouTube / docs source 统一进入索引层
3. 新增、修改、删除知识文件后自动触发后台重建
4. 详情弹层改成懒加载，只有点击后才读 `content.md` / 字幕 / HTML
5. 知识页搜索先只搜 summary 元数据，不做全文索引
6. advisor/member 运行时可调用 `knowledge_glob / knowledge_grep / knowledge_read`
7. 搜索工具默认按成员作用域过滤，不允许 agent 直接越过知识边界搜全库

### 详细技术路线

#### 1. 索引层

宿主维护 `knowledge_catalog.sqlite`，只保存文件级 summary，不保存全文 chunk。

用途分成两类：

- UI 列表和分页
- agent 搜索工具的候选文件底座

#### 2. 搜索工具层

阶段 1 直接提供 3 个原子工具：

- `knowledge_glob`
  - 适合按文件名、路径、kind、tag 缩小范围
  - 典型场景：先找“规范文档”“某成员的历史样例”“某类视频笔记”
- `knowledge_grep`
  - 适合按 query 在 summary 字段里搜候选文件
  - 当前只搜 catalog 字段，不读正文全文
- `knowledge_read`
  - 适合打开具体知识项详情
  - 读取 detail 内容时仍然受成员作用域约束

#### 3. 成员作用域约束

阶段 1 的核心不是智能排序，而是先把边界做对。

每条知识项要能映射到：

- `member-private`
- `project-shared`
- `team-shared`
- `global`

每次工具调用都必须带：

- `advisorId`
- `spaceId`
- `includeShared`
- `includeGlobal`

系统先做权限过滤，再执行搜索。

#### 4. agent 典型检索模式

推荐的使用模式：

1. agent 先用 `knowledge_grep` 搜主题词
2. 若结果太多，再用 `knowledge_glob` 限定 kind 或路径
3. 对 top 1-3 个结果使用 `knowledge_read`
4. 根据读取到的内容再决定是否继续读更多文件

不推荐：

- 首轮直接读大量文件
- 系统在阶段 1 自动做多轮重排
- 直接引入全文 FTS 或向量检索

#### 5. 为什么这样设计

这样设计的目标不是“宿主比 agent 更聪明”，而是：

- 宿主提供足够快、足够稳、受限的搜索底座
- agent 保持自主检索能力
- 运行时工具调用轨迹可观测、可解释、可审计

#### 6. 与 embedding 模块的边界

阶段 1 和阶段 2 的知识检索底座，与旧 embedding/similarity 模块的边界必须保持明确：

- catalog index 不负责生成 embedding
- `knowledge_glob / knowledge_grep / knowledge_read` 不依赖 embedding
- advisor/member/chatroom runtime 在知识检索上不依赖 embedding
- language-aware retrieval 也先基于 metadata、scope、language 和 file index，不引入 vector lane
- 若某个旧页面仍保留相似度排序分支，该分支必须是显式、可关闭、与成员检索主链路解耦的旁路能力

### 主要改动文件

- 新增：
  - `src-tauri/src/knowledge_index/*`
- 修改：
  - `src-tauri/src/commands/library.rs`
  - `src-tauri/src/knowledge.rs`
  - `src-tauri/src/main.rs`
  - `src-tauri/src/workspace_loaders.rs`
  - `src-tauri/src/runtime/*`
  - `src-tauri/src/tools/*`
  - `src/pages/Knowledge.tsx`
  - `src/bridge/ipcRenderer.ts`
  - `src/types.d.ts`

### 必须使用的现成库

- `rusqlite`
- `notify`
- 文件指纹与哈希库，或本地稳定哈希实现

### 必须自研的部分

- catalog schema
- 文件变化去抖与重建策略
- summary / detail 分层接口
- 知识页分页与懒加载链路
- 成员作用域过滤逻辑
- `knowledge_glob / knowledge_grep / knowledge_read` 的工具契约

### 性能目标

- 知识页热启动首屏 `< 150ms`
- 知识页冷启动首屏 `< 400ms`
- 详情打开 `< 200ms`
- 列表查询时间不再随着正文长度线性恶化
- 后台建索引不阻塞页面首次渲染
- 单次 `knowledge_grep` catalog 查询 `< 120ms`
- 单次 `knowledge_read` 打开详情 `< 250ms`

### 明确收益

- 知识页不再随着文件数量增加而明显变慢
- agent 可以像 Claude Code 一样，自主组合 `glob / grep / read` 做知识检索
- 后续语言感知检索有稳定的文件索引底座
- 后续成员技能检索不用再直接扫文件系统

### 验收标准

- 首次无索引时，页面壳能立即显示，索引后台构建完成后自动刷新
- 再次进入知识页时，不再扫描全文内容
- 新增 / 删除 / 修改知识文件后，catalog 能自动更新
- docs source 的 `fileCount` / `sampleFiles` 仍能显示
- advisor/member runtime 中可调用 `knowledge_glob / knowledge_grep / knowledge_read`
- 这些工具返回结果已按成员作用域过滤
- agent 不需要宿主额外重排，也能完成“先搜文件，再读文件”的基本检索闭环

### 回滚策略

- 关闭 `knowledgeCatalogIndex` 后回退到旧 knowledge list 链路
- 关闭 `knowledgeLazyDetail` 后恢复旧的全量详情对象方式

## 阶段 2：语言元数据与语言感知检索

### 目标

在 catalog index 基础上，把语言识别变成知识元数据层，并让检索能够优先按语言、作用域、证据权重返回更正确的结果。

### 交付物

- 知识项新增自动语言字段
- query language 检测接入检索链路
- 成员/项目/团队/全局作用域检索生效
- 旧 embedding/similarity 模块继续保留但不参与默认检索主路径

### 功能内容

1. 上传知识或索引重建时自动识别语言
2. 检索优先命中 query 同语言内容
3. 在排序层引入 `language_match` 与 `scope` 权重
4. UI 显示命中语言与命中来源摘要

### 主要改动文件

- `src-tauri/src/knowledge.rs`
- `src-tauri/src/commands/runtime_query.rs`
- `src-tauri/src/commands/workspace_data.rs`
- `src-tauri/src/search/*`
- `src/pages/Knowledge.tsx`

### 性能目标

- 本地小中型知识库平均检索耗时 `< 250ms`
- 大型知识库平均检索耗时 `< 600ms`
- 同语言 top-5 命中准确率提升 `>= 25%`

### 明确收益

- 中英混合知识库命中更稳
- 作用域更清晰，为成员技能层提供可复用检索底座
- 后续 member package 不需要自己实现底层检索

### 验收标准

- 中文 query 优先命中中文内容
- 英文 query 优先命中英文内容
- UI 可见命中语言与命中原因
- 作用域过滤正确，不会误串成员私有知识

### 回滚策略

- `languageAwareKnowledgeRetrieval=false` 时回退到 catalog + 旧检索链路

## 阶段 3：蒸馏技能与成员技能包落盘

### 目标

把成员知识库从“原始文件集合”升级成“可蒸馏成员技能包”，但暂不让它主导运行时，只先完成结构化落盘与预览。

### 交付物

- 内置技能：`member-skill-distiller`
- 新命令：
  - `members:distill-skill`
  - `members:preview-distillation`
  - `members:detect-knowledge-language`
- 新落盘结构：
  - `skills/members/<advisor-slug>/...`
- advisor 新增自动语言字段：
  - `detectedKnowledgeLanguage`
  - `languageDetectionStatus`
  - `languageConfidence`

### 功能内容

1. 上传知识文件后自动启动后台语言识别
2. 允许手动触发“蒸馏技能”
3. 蒸馏结果预览后再落盘
4. `knowledgeLanguage` 从“用户输入”升级成“自动结果 + 人工覆盖”

### 主要改动文件

- 新增：
  - `src-tauri/src/member_skill/distill.rs`
  - `src-tauri/src/member_skill/language.rs`
  - `src-tauri/src/member_skill/package.rs`
  - `builtin-skills/member-skill-distiller/SKILL.md`
- 修改：
  - `src-tauri/src/commands/advisor_ops.rs`
  - `src-tauri/src/workspace_loaders.rs`
  - `src/pages/Advisors.tsx`

### 性能目标

- 小型知识库语言识别 `< 1s`
- 中型知识库语言识别 `< 5s`
- 蒸馏预览生成：
  - 小型知识库 `< 3s`
  - 中型知识库 `< 10s`
- 全部走后台任务，不阻塞页面首次渲染

### 明确收益

- 减少手动设错知识语言导致的 persona 偏差
- 成员 persona 不再只是单段 prompt，而开始成为可版本化技能包
- 为运行时接入做准备，但不提前耦合

### 验收标准

- 上传知识库后，UI 30 秒内能显示自动识别语言
- 支持“自动值 / 手动覆盖值 / 覆盖原因”三态
- 触发蒸馏后，`skills:list` 能发现新成员技能
- 生成的技能包目录完整，包含结构化文件，不只有 `SKILL.md`

### 回滚策略

- 若蒸馏链路不稳定，保留旧 advisor prompt 生成功能
- 若自动语言识别异常，退回手动覆盖模式

## 阶段 4：成员技能包接入运行时

### 目标

让成员技能包真正进入 runtime context assembly，而不是停留在静态文件层。

### 交付物

- runtime 可基于 `advisorId` 自动激活对应成员技能
- 成员技能参与 `ContextBundle`
- 旧 `personality / system_prompt` 退为 fallback

### 功能内容

- 为 advisor 会话新增 `memberSkillName` 或 `memberSkillRef`
- `runtime:query` 组包时注入：
  - 成员身份摘要
  - 核心风格
  - 核心规则
  - 工具摘要
- 只在命中需要时补充 heuristics 与 references

### 主要改动文件

- `src-tauri/src/skills/runtime.rs`
- `src-tauri/src/commands/runtime_query.rs`
- `src-tauri/src/chat_helpers.rs`
- `src-tauri/src/interactive_runtime_shared.rs`
- `prompts/library/runtime/advisors/*`

### 性能目标

- advisor 场景平均 `renderedPromptChars` 下降 `>= 20%`
- 首 token 时间不劣化超过 `5%`
- 激活成员技能的运行时额外开销 `< 30ms`

### 明确收益

- 人格漂移下降
- prompt 更短、更稳定
- 成员风格跨轮保持更一致

### 验收标准

- diagnostics 中可看到当前激活的成员技能
- 同一成员连续 10 轮对话的人格一致性明显提升
- 禁用成员技能后系统能无错误回退到旧 advisor prompt

### 回滚策略

- 关闭 `memberRuntimeOverlay` 后恢复旧 advisor 链路

## 阶段 5：成员工具能力成员化

### 目标

让成员不仅能按风格说话，还能在权限边界内调用工具做事。

### 交付物

- 每个成员技能包包含 `tool_policy.json`
- runtime 能根据成员技能收窄工具集
- 高风险工具继续走现有 capability guardrails

### 工具分层

- `read-only`
  - docs search
  - file read
  - log query
  - metrics query
- `light-write`
  - create draft
  - create ticket
  - write summary
- `high-risk`
  - repo write
  - MCP write actions
  - deploy / publish / destructive actions

### 主要改动文件

- `src-tauri/src/skills/permissions.rs`
- `src-tauri/src/tools/packs.rs`
- `src-tauri/src/tools/guards.rs`
- `src-tauri/src/commands/mcp_tools.rs`
- `src-tauri/src/runtime/*`

### 性能目标

- 工具误选率下降 `>= 40%`
- 工具调用成功率 `>= 85%`
- 高风险误触发 `= 0`
- 平均工具规划步数下降 `>= 20%`

### 明确收益

- 角色更像真实岗位成员
- 工具面更干净，模型决策更快
- 安全边界更清晰

### 验收标准

- 不同成员激活后看到的工具集合不同
- 被禁工具调用会进入 capability audit 并给出明确 reason
- 背景任务与子代理默认仍比交互式更严格

### 回滚策略

- 关闭 `memberToolPolicy` 后回退为 runtimeMode 默认工具包

## 阶段 6：持续蒸馏与自动更新闭环

### 目标

让成员技能包能够随新知识和新行为持续进化，但不失控。

### 交付物

- 新素材进入后台蒸馏队列
- 生成“蒸馏候选”
- 支持人工审核后合并
- 技能包版本化、可回滚、可对比

### 新增能力

- `members:enqueue-distillation`
- `members:list-distillation-candidates`
- `members:approve-distillation`
- `members:rollback-skill-version`
- `members:evaluate-skill`

### 主要改动文件

- 新增：
  - `src-tauri/src/member_skill/versioning.rs`
  - `src-tauri/src/member_skill/eval.rs`
  - `src-tauri/src/member_skill/background.rs`
- 修改：
  - scheduler/background runtime
  - diagnostics / settings / advisors UI

### 性能目标

- 新知识文件进入可检索状态 `<= 5 分钟`
- 新知识进入下一版蒸馏候选 `<= 30 分钟`
- 回归评测单次批处理可在后台运行，不阻塞交互

### 明确收益

- 成员不再需要频繁手工重写 prompt
- 新知识与新经验会逐步沉淀进成员技能
- 有版本、有审计、有回滚

### 验收标准

- 新上传会议纪要后，成员能在下一版技能中体现新规则或新事实
- 每次版本升级都能看到：
  - 新增规则
  - 变更 heuristics
  - 来源证据
  - 审核人
- 可回滚到上一稳定版本

### 回滚策略

- 关闭 `memberSkillAutoRefresh`
- 停留在最近稳定版本，不影响在线回答

## 7. 必须使用现成库 vs 必须自研

### 必须使用现成库

- 语言识别：`lingua-rs`
- 短期全文检索：`SQLite FTS5`
- 中期全文检索：`Tantivy`
- 中文分词：`tantivy-jieba`
- 音频转写：Whisper 现有链路
- 说话人分离：后续若接会议人格蒸馏，可接 `pyannote`

### 必须自研

- 成员技能包 schema
- 蒸馏候选生成与审核流
- 语言聚合策略
- 作用域检索排序
- 成员工具权限模型
- 版本治理与评测体系

## 8. 评测体系

每阶段都必须跑最小评测集。建议建立固定 eval 数据集：

- 风格一致性问题集
- 规则遵守问题集
- 多语言知识检索问题集
- 工具调用安全问题集
- 历史案例复现问题集

建议最少跟踪以下指标：

- `persona_consistency_score`
- `rule_adherence_score`
- `retrieval_hit_at_5`
- `language_match_precision`
- `tool_success_rate`
- `unsafe_tool_attempts`
- `avg_prompt_chars`
- `avg_retrieval_latency_ms`
- `avg_first_token_ms`

## 9. 风险清单

### 风险 1：蒸馏结果过拟合风格，牺牲事实性

控制：

- Persona 与 Knowledge 分层
- 规则与风格分开存
- 回答必须优先引用证据

### 风险 2：语言检测误判导致错误检索路由

控制：

- 保留人工覆盖
- 记录 confidence
- 低置信度时允许多语言并行检索

### 风险 3：成员技能包过大，反而增加 prompt 开销

控制：

- SKILL.md 只放最小必要内容
- heuristics / references 按需加载
- 使用 section budget 控制注入体积

### 风险 4：工具能力成员化后误触高风险动作

控制：

- 继续复用 capability guardrails
- 成员工具策略只负责“收窄”，不负责绕过审批

## 10. 推荐执行顺序

推荐的落地顺序：

1. 阶段 0：补齐观测
2. 阶段 1：文件索引与 agent 可调用检索工具
3. 阶段 2：语言元数据与语言感知检索
4. 阶段 3：蒸馏技能与成员技能包落盘
5. 阶段 4：成员技能进入 runtime
6. 阶段 5：成员工具能力
7. 阶段 6：自动更新闭环

如果资源有限，最先保证：

- 阶段 1 全量完成
- 阶段 2 至少完成 advisor 单聊接入
- 阶段 3 先完成语言过滤 + 成员作用域路由

这三步完成后，系统就已经具备可用的“成员技能化”主链路。

## 11. 近期实施建议

建议把最近两周的工作收敛成三个可交付里程碑：

### 里程碑 A

- 建立阶段 0 观测
- 完成 `knowledge catalog` 与自动重建
- 完成 `knowledge_glob / knowledge_grep / knowledge_read` 最小版

### 里程碑 B

- 完成自动语言识别基础版
- 完成语言感知检索最小版
- advisor 单聊可稳定使用成员作用域搜索工具

### 里程碑 C

- 完成 `member-skill-distiller` 的最小落盘链路
- 成员技能包接入 advisor runtime
- 建立最小评测集

## 12. 完成定义

当以下条件全部满足时，可认为该迁移完成：

- 每个成员都能从知识库蒸馏出可版本化技能包
- 知识库语言可自动识别并进入检索/蒸馏/运行时链路
- runtime 能按成员激活技能，而不是只读一段 advisor prompt
- 检索支持语言感知与成员作用域
- 成员具备受控工具能力
- 技能升级具备审计、评测、回滚

在达到上述条件前，不应删除旧 advisor fallback 链路。
