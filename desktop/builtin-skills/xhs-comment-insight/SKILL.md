---
name: xhs-comment-insight
description: 小红书评论区洞察选题技能，用于从单条笔记的评论区统计和分析追问、反驳、补充、情绪和未满足需求，生成 1 个可继续创作的小红书选题。
allowedRuntimeModes: [wander, chatroom]
hookMode: inline
autoActivate: false
activationScope: session
activationHint: 当选题中心随机挑取一条小红书笔记，并要求分析这条笔记评论区后产出潜在选题时，加载本技能；在 AI 聊天中，当用户明确要求“评论区洞察”、分析一条小红书笔记的评论、从评论里找选题、或输入 `/xhs-comment-insight` 时，也可调用 `Operate(resource="skills", operation="invoke", input={ "name": "xhs-comment-insight" })` 单独激活。
contextNote: 评论区洞察阶段只处理本轮提供的 1 条笔记与评论摘录；AI 聊天中如果用户没有提供笔记和评论内容，应先要求用户提供评论素材或选择一条带评论的小红书笔记，不要读取长期记忆、账号定位或未提供素材。
promptPrefix: 你当前已加载 xhs-comment-insight。评论区洞察流程固定为：1 条小红书笔记 -> 统计和分析该笔记评论区 -> 输出 1 个潜在选题。选题中心会随机提供 1 条带评论笔记；AI 聊天中则使用用户本轮提供或指定的 1 条笔记评论素材。它不是评论摘要，也不是复述原笔记；它要从评论里的真实用户问题、误解、反驳、补充信息、情绪和行动需求中提炼一个更值得写的新选题。最终只能输出严格 JSON。
promptSuffix: 完成前执行 xhs-comment-insight 输出自检：只能输出一个 JSON 对象，不要 Markdown、代码块或解释；topic.title、content_direction、direction_frame 四字段必须完整；topic.connections 必须是 [1]。
maxPromptChars: 3600
---
# XHS Comment Insight

用于选题中心和 AI 聊天的评论区洞察。选题中心宿主负责随机提供本轮 1 条带评论的小红书素材和评论摘录；AI 聊天中，用户可以直接提供或指定 1 条小红书笔记及评论素材。本技能负责统计、分析这条笔记评论里真正值得二次创作的内容机会。

核心原则：评论区洞察不是跨素材综合，不是统计评论数量，也不是把热评改写成标题。它要在单条笔记评论区里找到“读者真正还想知道什么”，再收敛成一个足够小、能写成一篇小红书图文的潜在选题。

## 输入边界

- 只使用本轮 1 条笔记、本轮提供的评论摘录，以及必要时补读到的同一条笔记的 `comments.json` / `meta.json` / 正文文件。
- AI 聊天中如果只有泛泛需求、没有笔记和评论内容，先请用户提供评论素材或选择一条带评论的小红书笔记。
- 原笔记正文只作为背景，评论区才是主输入。
- 不引入长期记忆、账号定位、用户档案或其他知识库内容。
- 预读评论足够时不要调用工具；只有评论上下文缺口影响判断时，才补读具体文件。

## 评论价值类型

先给评论分型，再选选题。

| 评论信号 | 说明 | 更适合生成的选题 |
| --- | --- | --- |
| 追问 | 用户问“在哪、怎么、为什么、能不能” | 教程、解释、避坑、补充说明 |
| 反驳 | 用户不同意、纠正、质疑原文 | 观点澄清、争议讨论、反常识 |
| 补充 | 用户提供案例、事实、资源、经历 | 案例拆解、信息增量、资源型 |
| 情绪 | 用户表达焦虑、想要、羡慕、害怕、愤怒 | 共鸣、身份代入、痛点安抚 |
| 行动意图 | 用户求链接、求模板、求方法、求名单 | 工具清单、步骤、交付型内容 |
| 作者互动 | 作者回复承诺、澄清或引导 | 后续内容承接、FAQ、系列化 |

## 思考流程

1. 先统计这条笔记评论区的信号：看高赞评论、回复数、追问密度、反驳点、补充信息和具体行动诉求，不只看评论总数。
2. 从评论里提取 2-4 个真实需求或矛盾：用户到底还缺什么信息、哪里不信、哪里有误解、哪里想继续行动。
3. 选择一个最小切口并输出 1 个潜在选题：优先选具体问题、具体场景、具体人群，不要做“评论区都在问什么”这种大题。
4. 让原笔记退到背景位：`content_direction` 必须说明“评论区里哪个信号触发了选题”，而不是只说原文主题。
5. 不跨素材组合，不输出多个方向。
6. 标题先按 `xhs-title` 的小红书标题逻辑内部筛选，最终 JSON 只输出一个 20 字以内标题。

## 质量标准

- 选题必须来自评论区信号，而不是原笔记正文摘要。
- `content_direction` 必须包含评论信号，例如“高赞评论在追问...”“评论区反驳点是...”“多人求...”
- `direction_frame.target_reader` 要是具体读者，不要写“所有小红书用户”。
- `direction_frame.core_tension` 要体现评论区暴露的矛盾。
- `direction_frame.angle` 要说明从什么角度写，而不是泛泛“分析评论区”。
- `direction_frame.material_entry` 要写清“评论信号 + 原笔记背景”的来源。
- `topic.connections` 必须是 `[1]`。

## 反模式

- 不要输出评论摘要。
- 不要按评论点赞排序直接搬运热评。
- 不要把评论区所有观点做成合集。
- 不要把原笔记重新写一遍。
- 不要产出“用户为什么会评论”这类抽象研究题。

## 最终输出标准

最终只输出一个 JSON 对象。不要输出 Markdown、不要用 ```json 代码块、不要输出字段说明、不要把中间分析对象塞进结果。

single_choice 必须严格使用这个结构：

```json
{
  "content_direction": "一句话说明评论区哪个信号触发了选题、原笔记提供什么背景、最终小切口是什么",
  "thinking_process": [
    "评论信号：素材 X 的评论集中在追问/反驳/补充...",
    "需求判断：读者真正缺的是...",
    "收敛判断：最终选题足够小，能一篇笔记讲透"
  ],
  "topic": {
    "title": "20字以内的真实内容标题",
    "connections": [1]
  },
  "direction_frame": {
    "target_reader": "具体目标读者",
    "core_tension": "评论区暴露的具体核心矛盾",
    "angle": "具体叙事角度",
    "material_entry": "评论信号和原笔记背景来源"
  }
}
```

输出前按顺序检查：

1. 顶层字段只能是 `content_direction`、`thinking_process`、`topic`、`direction_frame`；不要输出 `options`、`selected_index` 或多个候选。
2. `thinking_process` 只能是 2-4 条短字符串，不能是对象。
3. `topic.title`、`content_direction`、`direction_frame.target_reader`、`direction_frame.core_tension`、`direction_frame.angle`、`direction_frame.material_entry` 都不能为空。
4. `topic.connections` 必须是 `[1]`。
5. 如果 JSON 会超过输出预算，删减 `thinking_process`，不能删最终结构字段。
