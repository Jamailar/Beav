---
doc_type: plan
execution_status: in_progress
last_updated: 2026-06-30
related_docs:
  - desktop/docs/creative-template-skill-system-plan.md
  - desktop/docs/skill-marketplace-multi-source-upgrade-plan.md
---

# AI 内容模板系统阶段性结论

## 1. 当前结论

模板不应该简单等同于 `skill`，也不应该只是 prompt 文本。

更合理的边界是：

```text
Template = 面向用户的创作入口和结构化蓝图
Skill = AI 执行某类创作任务的能力说明
Workflow = 多步骤执行编排
Renderer / Editor = 文章、图文、视频等结果的承载界面
Template Pack = 可分发、可版本化的模板集合
```

也就是说，用户看到的是“模板”，AI 真正执行时使用的是模板生成的结构化 brief，并由对应的 skill / workflow 完成创作。

这会修正旧方案里“Template As Skill Bundle”的表述：模板可以依赖 skill，也可以和 skill 一起打包分发，但模板本身应该是一等产品实体，而不是 skill 的 subtype。

## 2. 外部产品调研摘要

### Canva / Adobe Express

这类产品把模板做成可编辑版式：布局、素材、样式、文本槽位、图片槽位。AI 负责根据用户描述生成设计候选，用户再在编辑器里替换和调整。

对我们的启发：

- 图文模板需要显式的视觉槽位和版式结构。
- AI 生成的结果应该还能进入编辑器继续修改。
- 模板不是一段 prompt，而是可编辑结构。

参考：

- https://openai.com/index/canva/
- https://helpx.adobe.com/express/web/create-with-templates/text-to-template.html

### CapCut / HeyGen

视频模板本质是时间线模板：场景、素材占位符、字幕、音频、转场、人物、配音等。HeyGen 的 Template API 采用 `template_id + variables` 模式，变量可以是 text、image、video、audio、voice、character。

对我们的启发：

- 视频模板必须用强类型变量承载素材。
- 视频模板应该抽象成 timeline contract，而不是视频文件本身。
- “替换变量后生成结果”比“自由 prompt 生成视频”更稳定。

参考：

- https://www.capcut.com/resource/capcut-template-videos
- https://developers.heygen.com/template-api

### Descript

Descript 更接近 AI 创作工具。它把模板描述为可复用 creative brief，用来指导 AI co-editor 创建或编辑内容。自定义模板时需要 prompt、标题、描述、缩略图、标签。

对我们的启发：

- 对 AI 工具来说，模板的核心不是版式，而是可复用的创作 brief。
- 模板需要产品字段：名称、描述、封面、标签、适用场景。
- brief 应包含 action、context、tone、format、constraints。

参考：

- https://help.descript.com/hc/en-us/articles/40771730752525-Create-and-save-your-own-templates

### Jasper / Copy.ai

这类产品把模板做成表单和工作流。Jasper 强调根据 `inputSchema` 动态生成 UI，用户填写关键字段后生成内容。Copy.ai 的 workflow template 则更像多步骤自动化。

对我们的启发：

- 模板需要 `inputSchema`，让 UI 自动生成输入表单。
- 工作流模板可以串联多个 AI 步骤，不只是生成一段内容。
- 用户不应该从空白 prompt 开始，而应该从结构化输入开始。

参考：

- https://developers.jasper.ai/docs/common-use-cases
- https://www.copy.ai/workflows/long-form-blog-post-generator

## 3. 内容如何变成模板

“把内容变成模板”不是复制原内容，而是抽取可复用结构。

标准流程建议为：

```text
原始内容
-> AI 分析内容类型和创作目标
-> 抽取结构骨架
-> 标记可替换变量
-> 标记内容槽位 / 素材槽位 / 时间线槽位
-> 生成 Template Manifest 草稿
-> 用户确认和编辑
-> 发布为模板或保存为个人模板
```

### 文章类内容

从文章中抽取：

- 标题公式
- 段落顺序
- 叙事结构
- 语气风格
- 字数范围
- 论据类型
- 结尾方式
- 必须包含和必须避免的内容

示例结构：

```text
hook
pain
insight
solution
proof
cta
```

### 图文类内容

从图文内容中抽取：

- 图片数量
- 每张图的角色
- 封面图结构
- 每张图的文字槽位
- 图片比例
- 视觉风格
- 发布正文结构
- 标签策略

示例结构：

```text
cover
problem_card
method_card
example_card
summary_card
caption
hashtags
```

### 视频类内容

从视频中抽取：

- 视频时长
- 分镜数量
- 每段镜头目标
- 画面类型
- 旁白结构
- 字幕节奏
- B-roll 类型
- 封面标题
- 行动引导

示例结构：

```text
scene_1_hook
scene_2_problem
scene_3_process
scene_4_result
scene_5_cta
```

视频模板应该沉淀为 timeline contract，而不是保存一个不可编辑的视频文件。

## 4. AI 如何使用模板

AI 不应该收到一句“按这个模板写”。运行时应该给 AI 一个结构化任务：

```text
用户选择模板
-> UI 根据 inputSchema 收集输入
-> Runtime 构造 TemplateRun
-> TemplateRun 显式声明 requiredSkills / workflow / outputContract
-> AI 读取模板结构和用户输入
-> skill / workflow 执行创作
-> 工具层生成文章、图像 brief、视频分镜、时间线等产物
-> 质量检查
-> 写入 Manuscripts / Media / Video Editor / RedClaw
```

关键点：

- 模板负责定义结构，不直接替代 skill。
- skill 负责创作方法和质量标准。
- workflow 负责多步骤执行顺序。
- outputContract 负责把结果稳定落到编辑器。
- runtime 通过 typed metadata 激活能力，避免根据用户自然语言关键词硬路由。

## 5. Template Manifest 草案

阶段性建议用统一 manifest 描述所有内容模板。

```json
{
  "templateKey": "xhs-product-note",
  "title": "小红书产品种草笔记",
  "description": "把产品卖点转成小红书图文笔记",
  "categoryKey": "social.xiaohongshu.note",
  "tagKeys": ["product-review", "seeding", "ugc-style"],
  "contentTypes": ["article", "image_pack"],
  "targetPlatforms": ["xiaohongshu"],
  "inputSchema": [
    {
      "key": "productName",
      "label": "产品名",
      "type": "text",
      "required": true
    },
    {
      "key": "targetAudience",
      "label": "目标人群",
      "type": "text",
      "required": false
    },
    {
      "key": "sellingPoints",
      "label": "核心卖点",
      "type": "list",
      "required": true
    }
  ],
  "slots": [
    {
      "slot": "hook",
      "role": "开场钩子",
      "constraints": ["必须在 2 行内说清痛点或结果"]
    },
    {
      "slot": "proof",
      "role": "体验证明",
      "constraints": ["优先使用用户提供的素材和证据"]
    }
  ],
  "requiredSkills": ["xhs-note-writer", "social-cover-director"],
  "workflow": [
    {
      "step": "analyze_input",
      "kind": "reasoning"
    },
    {
      "step": "write_note",
      "kind": "skill",
      "skillRef": "xhs-note-writer"
    },
    {
      "step": "create_cover_brief",
      "kind": "skill",
      "skillRef": "social-cover-director"
    }
  ],
  "outputContract": {
    "kind": "article_with_image_brief",
    "fields": ["titles", "body", "hashtags", "coverBrief", "imageBriefs"]
  },
  "qualityGate": {
    "checks": ["structure_complete", "platform_fit", "no_empty_required_slots"]
  }
}
```

## 6. 模板储存支持的数据类型

模板管理不能只存 prompt。阶段性建议按“数据库存可查询结构，OSS 存大文件资产”的原则设计。

```text
DB:
模板基础元数据
+ 分类 / 标签引用
+ manifest JSON
+ 版本
+ 发布者
+ 来源
+ app 可见性
+ 依赖关系
+ 运行统计

OSS:
模板包
+ 封面图
+ 预览图
+ 示例图片 / 视频 / 音频
+ 示例输出
+ manifest 文件快照
```

### 6.1 基础元数据

每个模板至少需要：

- `template_key`：稳定唯一 key。
- `title`：展示名称。
- `short_description`：列表页短描述。
- `description`：详情页说明。
- `content_types`：文章、图文、视频、封面、脚本、工作流等。
- `target_platforms`：小红书、抖音、公众号、视频号、B 站等。
- `category_id` / `category_key`：主分类。
- `tag_keys`：多个标签。
- `publisher_id`：发布者。
- `source_id`：来源市场。
- `status`：draft、reviewing、published、archived、disabled。
- `risk_level`：低风险、需要素材权限、需要外部账号等。
- `locale`：默认语言和地区。
- `sort_order` / `featured` / `pinned`：运营排序。

这些字段必须能被 appadmin 直接编辑或调整。

### 6.2 Manifest JSON

模板 manifest 是运行时核心，适合存 JSONB，同时将发布版本快照保存到 OSS。

manifest 中建议包含：

- `inputSchema`：UI 自动生成表单。
- `slots`：文本、图片、视频、音频、知识引用等槽位。
- `workflow`：AI 执行步骤。
- `requiredSkills`：依赖的 skill。
- `outputContract`：产物结构。
- `qualityGate`：质量检查。
- `exampleRefs`：示例输入和输出资产。
- `modelCapabilities`：文本、图像、视频、TTS 等能力需求。

数据库中的 manifest 用于查询、校验和运行；OSS 快照用于版本回滚、审计和客户端下载缓存。

### 6.3 输入字段类型

为了让模板覆盖文章、图文、视频和复杂工作流，`inputSchema` 必须强类型化。

首版建议支持：

| 类型 | 用途 |
|---|---|
| `text` | 短文本，如产品名、主题 |
| `textarea` | 长文本，如素材描述、品牌说明 |
| `number` | 数量、时长、字数 |
| `boolean` | 是否开启某个要求 |
| `select` | 单选，如语气、平台、风格 |
| `multi_select` | 多选，如卖点、标签 |
| `list` | 可增删列表，如卖点、步骤、镜头要求 |
| `rich_text` | 带格式的参考内容 |
| `image_ref` | 图片素材引用 |
| `video_ref` | 视频素材引用 |
| `audio_ref` | 音频素材引用 |
| `file_ref` | 通用文件引用 |
| `knowledge_refs` | 知识库条目引用 |
| `product_info` | 商品/服务结构化信息 |
| `brand_profile` | 品牌人设和语气信息 |
| `style_profile` | 风格档案 |

这些类型不代表都要首版做复杂控件，但 schema 必须先留出清晰边界。

### 6.4 槽位类型

模板应该管理内容槽位，而不是只管理最终文本。

建议槽位类型：

- 文本槽位：标题、开头、正文、口播、字幕、标签、CTA。
- 图片槽位：封面、图文卡片、商品图、参考图、背景图。
- 视频槽位：场景、分镜、B-roll、转场、字幕、配音、封面。
- 音频槽位：配音、背景音乐、音效。
- 知识槽位：引用证据、素材来源、事实约束。
- 工作流槽位：选题、分析、写作、生成图片、生成视频计划、质检。

槽位要支持 `required`、`repeatable`、`constraints` 和 `outputField`，这样 AI 生成后能稳定写入结果结构。

### 6.5 输出类型

模板运行后可以输出：

- `article`
- `social_post`
- `caption_pack`
- `image_brief`
- `image_pack`
- `cover_design_brief`
- `video_script`
- `video_plan`
- `timeline`
- `prompt_pack`
- `manuscript`
- `media_assets`
- `workflow_report`

输出类型必须和 Manuscripts、Media、Video Editor、RedClaw 的现有承载面保持一致。

### 6.6 版本与依赖

每次发布模板版本时必须记录：

- `version`
- `manifest_hash`
- `artifact_oss_key`
- `preview_asset_keys`
- `min_app_version`
- `required_skill_refs`
- `required_skill_versions`
- `required_model_capabilities`
- `changelog`

如果模板依赖的 skill 缺失，运行前必须给出明确状态：可安装、不可用、可降级。

## 7. 分类和标签管理

模板未来数量会很多，分类不能只写死在前端。分类和标签必须进入 appadmin 管理。

### 7.1 分类模型

分类用于主导航和运营组织，应该是受控数据。

建议支持树形分类：

```text
内容创作
├── 小红书
│   ├── 图文笔记
│   ├── 口播视频
│   └── 选题拆解
├── 短视频
│   ├── 分镜脚本
│   ├── 口播稿
│   └── 成片计划
├── 电商
│   ├── 商品种草
│   ├── 商品图
│   └── 详情页文案
└── 知识内容
    ├── 教程文章
    ├── 长图卡片
    └── 复盘报告
```

分类字段建议：

- `category_key`：稳定 key。
- `name`：展示名称。
- `parent_id`：父级分类。
- `description`：说明。
- `icon`：图标名或 OSS icon key。
- `content_type_scope`：适用内容类型，可为空表示通用。
- `platform_scope`：适用平台，可为空表示通用。
- `sort_order`：排序。
- `status`：active、hidden、disabled。
- `app_visibility`：哪些租户 app 可见。

每个模板建议只绑定一个主分类，避免列表和面包屑混乱。跨场景能力用标签表达。

### 7.2 标签模型

标签用于检索、筛选和运营推荐，可以比分类更灵活，但也应该可管理。

标签字段建议：

- `tag_key`：稳定 key。
- `name`：展示名称。
- `group`：标签组，如平台、行业、语气、格式、场景。
- `description`：说明。
- `color`：后台和前端展示色。
- `status`：active、hidden、disabled。
- `synonyms`：同义词，用于导入和搜索归一。
- `sort_order`：排序。

标签组建议：

- 平台：小红书、抖音、公众号、视频号。
- 内容形式：图文、口播、分镜、长文、卡片。
- 行业：美妆、教育、电商、餐饮、旅游。
- 目标：种草、转化、涨粉、留资、复购。
- 语气：真实体验、专业测评、轻松口语、强销售。
- 素材需求：需要图片、需要视频、需要知识库、需要商品信息。

标签可以多选，模板列表、热榜和推荐都应该支持按标签筛选。

### 7.3 分类和标签的管理动作

appadmin 需要支持：

- 新建、编辑、停用分类。
- 拖拽或输入排序。
- 调整父子分类。
- 设置分类适用内容类型和平台。
- 设置分类在不同 app 中是否可见。
- 新建、编辑、合并、停用标签。
- 给标签设置同义词，导入模板时自动归一。
- 查看分类/标签下模板数量。
- 阻止删除仍有关联模板的分类/标签，改用停用或合并。

### 7.4 必要实体边界

为了避免一开始过度设计，首版只需要：

```text
template_categories
template_tags
template_tag_bindings
```

模板主分类可以直接存在 `templates.category_id` 上，不需要单独建 `template_category_bindings`。只有标签需要多对多绑定表。

如果继续复用 skill market 的 package 表，也可以先在 `skill_market_packages` 上扩展：

```text
package_kind = template_pack
category_id
tags_json 或 package_tag_bindings
```

但长期看，分类和标签最好作为通用 taxonomy 能力，至少不要硬编码在 manifest 内部，否则 appadmin 很难统一管理和排序。

## 8. 和 Skill 市场的关系

模板可以复用现有技能市场的分发和治理能力，但需要扩展 package kind。

建议市场包类型：

```text
skill_pack
template_pack
workflow_pack
```

可复用现有能力：

- 来源 source
- 发布者 publisher
- OSS 镜像
- 版本
- app 可见性
- 安装 / 使用统计
- 热榜
- appadmin 管理

需要新增或扩展：

- template manifest 校验
- template preview assets
- template input schema 展示
- template category / tag filtering
- template run 事件统计
- template -> skill dependency 检查

阶段性建议：模板包不要先做复杂独立市场，先在同一 marketplace control plane 中扩展 `package_kind = template_pack`。

## 9. 首版产品建议

首版不要做几十个模板，先验证 4 类：

1. 文章模板：小红书种草笔记
2. 图文模板：知识卡片 / 长图图文
3. 视频模板：口播短视频脚本 + 分镜
4. 工作流模板：从素材生成小红书图文笔记

首版必须验证：

- 模板能从 UI 中被选择。
- UI 能根据 inputSchema 生成表单。
- AI 能根据 TemplateRun 和 requiredSkills 执行。
- 输出能进入现有 Manuscripts / Media / Video Editor。
- 模板使用次数能被统计。
- 模板可以通过 appadmin 管理。
- 分类和标签能通过 appadmin 管理，并能影响 app 端筛选。

暂不优先做：

- 用户公开发布模板
- 模板交易
- 大型模板商城首页
- 复杂模板编排器
- 模板 A/B 测试

这些应该等底层 contract 稳定后再做。

## 10. 仍需继续讨论的问题

1. 模板和 workflow 是否需要分成两个 package kind，还是 workflow 只是 template 的字段。
2. 模板是否需要“安装”，还是只需要“收藏 / 固定 / 离线缓存”。
3. 用户从内容一键抽模板时，是否允许自动发布，还是必须进入草稿审核。
4. 视频模板第一版应该输出 video plan，还是直接接现有视频编辑器 timeline。
5. 模板依赖的 skill 缺失时，是自动安装、提示安装，还是降级运行。
6. appadmin 中模板管理是否与 skill 管理共页，还是做成“创作资产市场”统一入口。
7. 模板热榜应统计“使用次数”还是“完成创作次数”，失败和取消是否计入。
8. 分类是全平台统一，还是允许每个租户 app 拥有独立分类树。
9. 标签是否允许用户自定义，还是仅由平台管理员维护。

## 11. 阶段性推荐

当前最稳妥的方向：

```text
Template Manifest 作为一等实体
+ Skill 作为执行能力
+ Workflow 作为多步骤编排
+ Marketplace 作为分发治理层
+ Editor / Manuscripts / Media / Video 作为结果承载层
```

不要走两个极端：

- 不要把模板简化成 prompt 文本。
- 也不要把模板完全塞进 skill，导致产品展示、输入表单、版本统计、热榜和素材预览都变得别扭。

下一步应该先定义 Template Manifest v0.1 和 TemplateRun contract，再决定 UI 和服务端数据结构。
