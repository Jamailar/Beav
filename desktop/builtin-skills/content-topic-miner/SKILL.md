---
name: content-topic-miner
description: 统一选题编排技能。用户在 AI 对话中要求找、生成、规划、每日刷新或评估自媒体选题时，先读取用户档案和创作者档案，检索知识库，再组合知识库相似内容挖掘、漫步式素材碰撞、评论区洞察、历史选题延展和必要的趋势检查，输出可执行选题池。
allowedRuntimeModes: [redclaw, wander, chatroom, default, team]
allowedTools: [resource, workflow]
hookMode: inline
autoActivate: false
activationScope: turn
activationHint: 当用户在 AI 对话中提出“想选题”“帮我找选题”“内容方向创作”“创作方向”“选题方向”“每天生成 N 个选题”“围绕我的方向找内容题”“做选题池/内容日历/栏目方向”，或只给出一个大方向如“AI相关”“职场相关”并期待生成自媒体选题时，调用 `Operate(resource="skills", operation="invoke", input={ "name": "content-topic-miner" })`。如果用户明确只要单条漫步或评论区洞察 raw JSON，可使用对应方法技能；否则由本技能统一编排。
contextNote: content-topic-miner 是 AI 对话里的最高层选题编排器。它可以读取用户档案、创作者档案、知识库、历史选题、评论素材和必要的当前事实，并把 wander-synthesis、xhs-comment-insight 等能力当作选题方法使用。方法内部仍保持各自输入纪律，外层负责选材、组合、去重、评分和最终解释。
promptPrefix: 你当前已加载 content-topic-miner。普通聊天里的选题请求不能只靠泛泛脑暴；先对齐用户目标和账号方向，再检索知识库，最后组合多种选题方法生成候选。AI 对话是外层编排器，可以调用所有已暴露能力，但不要破坏方法技能的内部输入边界。选题中心是所有选题的最终归档位置。
promptSuffix: 输出选题时必须标注每个候选的 method、source_evidence、target_reader、user_problem、content_value、fit_reason 和 score。在最终回复用户前，必须调用 `Operate(resource="topicCenter", operation="bulkUpsert", input={ "candidates": [...] })` 把最终候选写入选题中心；如果是在修改已有选题，调用 `operation="update"`。除非用户明确要求 raw JSON，只给用户可读的选题池和已保存说明，不要把内部 JSON 大段贴给用户。
maxPromptChars: 9000
---

# Content Topic Miner

用于 AI 对话里的统一选题编排。它不是单一的灵感生成器，而是把用户目标、创作者档案、知识库素材、评论信号、历史方向和必要的当前事实组合成可执行选题池。

## 产品定位

- AI 对话是最高层选题编排器，负责决定用哪些选题方法。
- `wander-synthesis` 是素材碰撞方法，擅长从小批量素材里找细小切口。
- `xhs-comment-insight` 是评论需求方法，擅长从单条笔记评论里找未满足需求。
- 本技能负责读档案、检索知识库、选择素材、分配方法、去重、排序和解释最终为什么适合当前账号。

不要把这些方法割裂成不同产品能力。用户只是在要“选题”，AI 需要按目标自动选择方法组合。

## 触发场景

使用本技能处理：

- 用户要求“帮我想选题”“找几个选题”“围绕某方向找内容题”。
- 用户要求“内容方向创作”“创作方向”“选题方向”，或只给一个大方向如“AI相关”。
- 用户要求“每天生成 10 个选题”“做选题池”“做内容日历”。
- 用户只给了一个账号方向、行业、主题或目标人群，没有指定素材。
- 用户希望从知识库、收藏、笔记、评论、历史素材里找内容方向。
- 用户要求比较、筛选、延展已有选题。

不使用本技能处理：

- 用户明确只要求改标题、写正文、做封面、剪视频。
- 用户明确只要求单条 `wander-synthesis` 或 `xhs-comment-insight` 的 raw JSON 输出。

## 编排流程

按这个顺序执行：

1. 识别任务类型：即时选题、每日固定数量、平台选题、栏目规划、已有选题延展、方法指定。
2. 读取目标上下文：优先读取 `profiles://creator_profile` 和 `profiles://user`，必要时读取相关 memory 或当前任务 brief。
3. 收敛目标方向：明确账号方向、目标读者、内容边界、平台、数量、时间范围和禁区。
4. 生成知识库查询词：用用户目标和账号方向生成 2-4 个查询词，不要只用用户原话。
5. 检索知识库：使用 `Search(path="knowledge://", query="...")` 找相似内容；读取 Top 3-6 个最相关素材。
6. 选择方法组合：根据素材类型和用户目标分配 knowledge mining、wander-style collision、comment insight、history extension、trend check。
7. 产出候选：每个方法输出可追溯候选，不要混淆原始方法证据。
8. 去重排序：按账号适配、读者问题、来源支撑、传播钩子、长期栏目价值、风险和新鲜度评分。
9. 写入选题中心：最终候选生成后，先调用 `Operate(resource="topicCenter", operation="bulkUpsert", input={ "candidates": [...] })` 保存；每个 candidate 使用 `topic_name`、`method`、`source_evidence`、`target_reader`、`user_problem`、`core_insight`、`content_value`、`fit_reason`、`score`、`sourceRefs`。
10. 输出最终选题池：给用户可执行列表和已写入选题中心的简短说明，不要只给抽象方向。

## 方法组合

默认方法如下。

| Method | 适用场景 | 输入 | 输出 |
| --- | --- | --- | --- |
| `knowledge_similar_mining` | 用户给方向、行业、平台、账号目标 | 档案 + 知识库相似内容 | 来源支撑强的选题 |
| `wander_style_collision` | 需要新鲜角度、素材库比较杂、需要灵感碰撞 | 3 条左右相关或互补素材 | 小切口、反差、场景化选题 |
| `comment_demand_insight` | 知识库里有评论、用户关心真实需求 | 1 条带评论笔记及评论摘录 | 从追问/反驳/补充里来的选题 |
| `history_extension` | 已有选题池或稿件，需要连续栏目 | 历史选题/稿件/记忆 | 系列延展、复盘、升级题 |
| `trend_check` | 用户要求今天/近期/热点/政策/平台规则 | 当前事实搜索结果 | 有时效依据的选题 |

如果用户要求每天 10 个选题，默认配比：

- 4 个 `knowledge_similar_mining`
- 2 个 `wander_style_collision`
- 2 个 `comment_demand_insight`
- 1 个 `history_extension`
- 1 个 `trend_check`，只有在用户目标需要当前事实时使用；否则改成知识库或历史延展。

根据知识库实际素材调整配比。如果没有评论素材，不要伪造评论洞察，改用 knowledge mining 或明确标注缺口。

## 方法边界

外层可以读取档案和知识库，但方法内部必须保持干净：

- 使用 `wander_style_collision` 时，先由外层选 3 条素材；进入方法后只基于这 3 条素材判断，不把档案和长期目标写进方法推理。
- 使用 `comment_demand_insight` 时，先由外层选 1 条带评论素材；进入方法后只基于该笔记和评论判断，不把其它知识库内容混成评论信号。
- 最终排序阶段再把档案、账号方向和长期目标纳入解释。

如果实际调用 `wander-synthesis` 或 `xhs-comment-insight`，把它们的 JSON 当作方法候选记录。最终用户可见格式仍由本技能统筹，除非用户明确要求 raw method output。

## 知识库检索策略

先构造查询词，再检索：

- 账号定位词：行业、赛道、内容对象、平台。
- 读者问题词：用户想解决的困惑、焦虑、行动阻碍。
- 内容价值词：方法、避坑、清单、案例、趋势、对比、观点。
- 风格边界词：创作者档案中的禁区、长期主张、商业目标。

检索时优先：

1. `Search(path="knowledge://", query="<目标读者 + 具体问题>")`
2. `Search(path="knowledge://", query="<行业/赛道 + 内容价值>")`
3. `Search(path="knowledge://", query="<平台 + 场景/评论/案例>")`
4. `Read(path="knowledge://...")` 深读 Top 3-6 个结果

不要为了显得勤奋扫全库。没有检索结果时，明确说知识库支撑不足，再用档案和用户输入生成低置信候选。

## 候选评分

每个选题按 10 分制评分：

- 2 分：是否匹配创作者档案和账号方向。
- 2 分：是否有明确目标读者和真实用户问题。
- 2 分：是否有知识库、评论或历史内容支撑。
- 1.5 分：是否有传播钩子，如反常识、痛点、清单、对比、案例、情绪。
- 1 分：是否能延展成系列或长期栏目。
- 1 分：是否足够小，可以一篇内容讲透。
- 0.5 分：风险低，事实边界清楚。

低于 7 分的候选默认不进入最终推荐，除非用户要求更多数量。

## 输出格式

普通请求输出：

```markdown
**选题池**
| Score | Topic | Method | Target reader | User problem | Source evidence | Fit reason |
| --- | --- | --- | --- | --- | --- | --- |
| 9/10 | ... | knowledge_similar_mining | ... | ... | ... | ... |

**推荐优先做**
- Topic: ...
- Why this wins: ...
- Next step: 写标题 / 写正文 / 做封面 / 加入每日任务
```

每日或批量任务输出：

- 先给方法配比。
- 再给 10 个最终选题。
- 每个选题必须有 method 和 source_evidence。
- 如果某方法因素材不足未使用，要说明替换原因。

## 质量禁区

- 不要只脑暴标题。
- 不要因为用户只给了一个大方向，就跳过档案、知识库、历史选题和技能调用直接给通用示例。
- 不要只复述知识库标题。
- 不要把 `wander-synthesis` 和 `xhs-comment-insight` 当成互斥产品入口；它们是选题方法。
- 不要伪造评论、互动数据、用户反馈或知识库来源。
- 不要把选题写成大而空的主题，如“AI 时代如何成长”“普通人如何做内容”。
- 不要把素材来源痕迹直接写成最终内容标题，如“从某笔记看...”。
- 不要把一次性用户要求写入长期档案，除非用户明确说这是长期方向。
