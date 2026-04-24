---
doc_type: plan
execution_status: not_started
last_updated: 2026-04-24
owner: codex
target_files:
  - desktop/src-tauri/src/redclaw_profile.rs
  - desktop/src-tauri/src/interactive_runtime_shared.rs
  - desktop/builtin-skills/writing-style/SKILL.md
  - desktop/skills/redclaw-writing-style-profile/SKILL.md
  - desktop/docs/redclaw-style-initialization-decision-tree-plan.md
success_metrics:
  - 首次初始化能区分销售导向与内容导向空间
  - 初始化问题树能生成稳定的长期档案与写作风格技能
  - Soul.md、user.md、CreatorProfile.md、writing-style overlay 的职责互不重叠
  - 后续用户纠偏可以增量更新风格规范而不污染通用 builtin skill
---

# RedClaw 首次风格初始化逻辑树方案

## 1. 目标

这份方案定义 `RedClaw` 在工作区第一次启动、第一次进入 AI 创作对话时的初始化流程。

目标不是做一个简单问卷，而是做一套接近“心理测试题”的多分支逻辑树，用尽量少的用户负担，收集足够稳定的长期创作信息，并把结果拆分写入：

- `Soul.md`
- `user.md`
- `CreatorProfile.md`
- workspace 级写作风格 overlay skill

这套流程必须满足三个条件：

1. 问题树能先判断空间的经营目标，再判断风格。
2. 风格判断必须大量使用文案 `A/B` 样例，而不是只问抽象形容词。
3. 采集结果必须能落到长期可执行规范，而不是停留在“用户说自己喜欢什么”。

## 2. 设计原则

### 2.1 先判断业务模式，再判断文案风格

如果不先判断这个空间到底是：

- 卖货
- 做内容
- 两者混合但有主次

那么后面的风格偏好都会失真。

同样一句“要有感染力”，在销售导向空间里可能意味着更强转化，在内容导向空间里可能意味着更高停留和收藏。

### 2.2 不直接问“你喜欢什么风格”

直接问用户“你喜欢什么风格”，用户会给出大量不可执行词：

- 高级
- 有质感
- 真诚
- 专业
- 温度感

这些词不能直接变成可执行写作规则。

必须改成：

- 多分支目标树
- 行为偏好题
- 文案样例 `A/B`
- 冲突校正题

### 2.3 首次初始化只生成“可执行初版”，不是最终人格定型

初始化流程的职责是生成第一版长期规则底盘，而不是一次性彻底理解用户。

因此需要保留：

- `confidence`
- `evidence_count`
- `needs_followup`

后续真实创作里的纠偏继续更新。

### 2.4 文档与 skill 严格分责

必须避免把同一条规则同时写进多个地方。

职责固定如下：

- `Soul.md`：RedClaw 如何与用户协作
- `user.md`：用户稳定事实与长期偏好摘要
- `CreatorProfile.md`：空间长期内容定位与经营策略
- `redclaw-writing-style-profile`：真正下笔时要执行的写作规范
- builtin `writing-style`：全局通用写作底盘，不承载用户个性化内容

## 3. 总体架构

## 3.1 输出层级

初始化完成后必须产出五层结果：

1. `raw_answers`
2. `structured_profile`
3. `document_projection`
4. `skill_projection`
5. `runtime_summary`

其中：

- `raw_answers` 保存原始用户答案与题目选择
- `structured_profile` 是唯一真源
- `document_projection` 负责生成 `Soul.md / user.md / CreatorProfile.md`
- `skill_projection` 负责生成 workspace overlay skill
- `runtime_summary` 是后续 prompt 注入的高密度摘要

## 3.2 建议新增的 canonical 文件

建议在 `redclaw/profile/` 下新增：

- `style-profile.json`

它是初始化流程和后续学习流程的唯一真源，建议包含：

```json
{
  "workspaceMission": {},
  "businessModel": {},
  "audienceModel": {},
  "brandStrategy": {},
  "writingPreferences": {},
  "collaborationPreferences": {},
  "confidence": {},
  "sources": []
}
```

这份 JSON 不直接给用户看，但所有文档和 skill 都从它投影。

## 4. 初始化流程总览

完整流程拆成 6 棵树，不是线性 5 题。

1. `空间目标树`
2. `经营模式树`
3. `受众与关系树`
4. `品牌与内容策略树`
5. `文案风格心理测试树`
6. `协作方式树`

每棵树都要先收敛关键分支，再决定下一棵树的问题。

## 5. 逻辑树一：空间目标树

这棵树决定整个空间的主 operating mode。

### 5.1 一级判断

题目名称：`这个空间最核心的目标是什么`

选项：

- `卖货 / 促成成交`
- `做内容 / 涨粉 / 点赞 / 收藏 / 留存`
- `既做内容也卖货，但内容优先`
- `既做内容也卖货，但成交优先`

### 5.2 分支规则

如果用户选择：

- `卖货 / 促成成交`
  进入 `经营模式树 -> 销售导向分支`
- `做内容 / 涨粉 / 点赞 / 收藏 / 留存`
  进入 `经营模式树 -> 内容导向分支`
- `既做内容也卖货，但内容优先`
  标记 `primary_mode=content`，`secondary_mode=sales`
- `既做内容也卖货，但成交优先`
  标记 `primary_mode=sales`，`secondary_mode=content`

### 5.3 该树的落盘

- `user.md`
  - 核心创作目标
- `CreatorProfile.md`
  - 空间定位
  - 经营优先级
- `style-profile.json`
  - `workspaceMission.primaryMode`
  - `workspaceMission.secondaryMode`
  - `workspaceMission.successMetrics`

## 6. 逻辑树二：经营模式树

这棵树只在明确一级目标后继续展开。

## 6.1 销售导向分支

### 6.1.1 二级判断

题目名称：`这个空间的销售方式更接近哪一种`

选项：

- `人设带货`
- `品牌带货`
- `单品爆款带货`
- `店铺矩阵带货`
- `高客单咨询/服务转化`

### 6.1.2 业务解释

- `人设带货`
  - 核心是经营“谁在推荐”
  - 可跨品牌
  - 文案更依赖信任、经历、观点和筛选能力

- `品牌带货`
  - 核心是经营某个固定品牌
  - 内容更强调品牌理念、一致性、产品线叙事

- `单品爆款带货`
  - 核心是快速放大单品卖点
  - 文案会更强调痛点、效果、场景、转化

- `店铺矩阵带货`
  - 核心是多 SKU、多个内容主题并行
  - 文案更需要栏目化、结构化

- `高客单咨询/服务转化`
  - 核心是建立专业信任
  - 文案更接近案例、方法论、筛选型表达

### 6.1.3 销售导向补充题

题目名称：`你更想让用户因为什么下单`

选项：

- `相信你这个人`
- `相信这个品牌`
- `相信这个产品真的解决问题`
- `相信你很专业，能替他们判断`

### 6.1.4 销售导向落盘

- `CreatorProfile.md`
  - 商业目标
  - 转化路径
  - 信任建立方式
- `style-profile.json`
  - `businessModel.salesMode`
  - `businessModel.conversionDriver`
  - `brandStrategy.trustSource`
- overlay skill
  - CTA 强度
  - 产品信息露出密度
  - 证据类型偏好

## 6.2 内容导向分支

### 6.2.1 二级判断

题目名称：`这个空间做内容，最主要追求什么结果`

选项：

- `点赞和评论`
- `收藏和转发`
- `关注和长期留存`
- `建立专业影响力`
- `为后续转化做信任积累`

### 6.2.2 内容导向补充题

题目名称：`你更希望别人看完后产生哪种感觉`

选项：

- `这个人很懂，值得继续关注`
- `这篇真的有用，我要存下来`
- `这件事说得很到位，我想互动`
- `这个账号的内容以后还会看`

### 6.2.3 内容导向落盘

- `user.md`
  - 成功指标
- `CreatorProfile.md`
  - 内容经营目标
  - 长期内容资产方向
- `style-profile.json`
  - `workspaceMission.contentGoal`
  - `workspaceMission.primaryMetric`
  - `brandStrategy.retentionStrategy`

## 7. 逻辑树三：受众与关系树

这棵树判断用户和受众之间的理想关系。

### 7.1 一级判断

题目名称：`你希望受众把你当成什么角色`

选项：

- `经验领先的过来人`
- `专业顾问 / 分析师`
- `真实试错者`
- `高审美内容创作者`
- `会帮他们省时间的人`

### 7.2 二级判断

题目名称：`你和受众的距离感应该是什么样`

选项：

- `像朋友，亲近自然`
- `像专业顾问，稍有距离`
- `像有判断力的前辈`
- `像品牌主理人，稳定可信`

### 7.3 该树作用

它不直接决定写作技巧，但会影响：

- 权威感
- 口语程度
- 第一人称比例
- 案例与自我暴露程度

### 7.4 该树落盘

- `user.md`
  - 用户长期偏好摘要
- `CreatorProfile.md`
  - 受众关系与角色定位
- `style-profile.json`
  - `audienceModel.relationshipDistance`
  - `audienceModel.authorityPosture`
  - `writingPreferences.selfExposureLevel`

## 8. 逻辑树四：品牌与内容策略树

这棵树解决“这个空间想长期成为什么样的账号”。

### 8.1 一级判断

题目名称：`这个空间更像哪一种长期资产`

选项：

- `稳定输出方法论的专业账号`
- `高辨识度的人设账号`
- `围绕某个品牌的官方/半官方账号`
- `爆点驱动的增长账号`
- `高信任度的转化账号`

### 8.2 二级判断

题目名称：`内容应该更偏哪一边`

选项：

- `长期品牌一致性`
- `短期爆发力`
- `两者平衡，但一致性优先`
- `两者平衡，但爆发优先`

### 8.3 三级判断

题目名称：`你愿意为了传播牺牲多少严肃感`

选项：

- `几乎不牺牲`
- `可以适度让文案更抓人`
- `只要不低俗，传播优先`

### 8.4 该树落盘

- `CreatorProfile.md`
  - 品牌方向
  - 内容策略
  - 爆发与一致性的权衡
- `style-profile.json`
  - `brandStrategy.accountArchetype`
  - `brandStrategy.consistencyVsVirality`
  - `writingPreferences.viralityTolerance`

## 9. 逻辑树五：文案风格心理测试树

这是最复杂的一棵树。

原则：

- 不问抽象形容词
- 不问“你喜欢高级感还是烟火气”
- 直接给 `A/B` 文案样例
- 每题只测一个维度
- 前题答案决定后题强度

## 9.1 题目组织方式

整棵树分成 10 个风格维度：

1. 开头钩子强度
2. 信息密度
3. 情绪温度
4. 权威姿态
5. 结构方式
6. 叙事比例
7. 销售显性程度
8. 金句/口号容忍度
9. 风险与冲突表达强度
10. CTA 强度

每个维度至少准备：

- `1` 组标准 `A/B`
- `1` 组 tie-break `A/B`
- `1` 组极端样本校正题

## 9.2 A/B 测试样题库结构

### 9.2.1 维度一：开头钩子强度

题目：`以下两种开头，你更愿意长期采用哪一种`

A：

> 很多人以为卖不动，是流量不够。  
> 但多数时候，问题根本不在流量。

B：

> 这周我重新看了 37 条转化不错的内容。  
> 最后发现，真正影响成交的不是你想的那个点。

判定：

- A 偏强钩子、判断先行
- B 偏观察式开头、细节先行

映射字段：

- `writingPreferences.hookStrength`
- `writingPreferences.openingStyle`

### 9.2.2 维度二：信息密度

A：

> 一篇能转化的内容，至少要同时解决三个问题：谁会停、为什么信、凭什么下单。

B：

> 内容能不能转化，先别想太复杂。  
> 你先想清楚一件事：别人凭什么信你。

判定：

- A 偏高密度
- B 偏低密度、易读

映射字段：

- `writingPreferences.informationDensity`

### 9.2.3 维度三：情绪温度

A：

> 我以前也很烦这种空话，所以后来写内容时，先把那些假热闹都删了。

B：

> 这类内容最大的价值，不是热闹，而是能不能留下真正有判断力的用户。

判定：

- A 偏有情绪、有个人感受
- B 偏冷静、抽离

映射字段：

- `writingPreferences.emotionalTemperature`
- `writingPreferences.selfExposureLevel`

### 9.2.4 维度四：权威姿态

A：

> 如果你现在还在靠“多发一点”解决问题，方向大概率已经偏了。

B：

> 如果你也遇到过这种情况，可以先检查是不是把节奏问题误判成了流量问题。

判定：

- A 偏高判断、强权威
- B 偏建议式、协商式

映射字段：

- `writingPreferences.authorityLevel`
- `collaborationPreferences.feedbackDirectness`

### 9.2.5 维度五：结构方式

A：

> 我只看三件事：内容有没有切中人、有没有留下判断、有没有给出行动理由。

B：

> 先说一个场景。  
> 然后你就会明白，为什么很多内容看起来热闹，最后却没人行动。

判定：

- A 偏框架化拆解
- B 偏场景叙事驱动

映射字段：

- `writingPreferences.structurePreference`
- `writingPreferences.storyRatio`

### 9.2.6 维度六：销售显性程度

A：

> 如果你本来就在做这个品类，这条内容可以直接改成你的成交前置脚本。

B：

> 先把内容写对，转化这件事后面才有资格谈。

判定：

- A 偏显性转化
- B 偏隐性铺垫

映射字段：

- `writingPreferences.salesExplicitness`
- `writingPreferences.ctaIntensity`

### 9.2.7 维度七：金句容忍度

A：

> 真正能卖出去的内容，不是更会说，而是更会让人信。

B：

> 内容有没有用，不在于句子响不响，而在于别人看完会不会改动作。

判定：

- A 偏允许口号化总结
- B 偏实用判断句

映射字段：

- `writingPreferences.sloganTolerance`

### 9.2.8 维度八：冲突表达

A：

> 最大的问题不是你不会写，而是你一直在写没人在乎的东西。

B：

> 很多时候，不是不会写，而是选题和用户在意的问题没有对上。

判定：

- A 偏冲突感强
- B 偏缓和表达

映射字段：

- `writingPreferences.conflictLevel`

### 9.2.9 维度九：CTA 强度

A：

> 如果你也在做这类内容，先把这套判断框架存下来再改稿。

B：

> 这类问题后面我还会继续拆，先记住今天这个判断就够了。

判定：

- A 偏明确行动指令
- B 偏弱 CTA

映射字段：

- `writingPreferences.ctaIntensity`

### 9.2.10 维度十：第一人称比例

A：

> 我后来发现，很多“经验分享”其实只是在重复套路。

B：

> 经验型内容最容易出问题的地方，是把套路当成判断。

判定：

- A 偏个人视角
- B 偏抽象分析

映射字段：

- `writingPreferences.firstPersonRatio`

## 9.3 分支追问规则

文案风格树不能一次把 10 个维度全问满。

建议规则：

- 必问：
  - 钩子强度
  - 信息密度
  - 情绪温度
  - 结构方式
- 按空间目标追加：
  - 销售导向：销售显性程度、CTA 强度、权威姿态
  - 内容导向：叙事比例、金句容忍度、冲突表达
- 当两个维度答案冲突时，触发 tie-break 题

示例：

- 用户既选了“冷静克制”
- 又选了“强冲突、强钩子、强 CTA”

则追加校正题：

题目：`如果只能保留一种感觉，你更希望内容给人的第一印象是`

- `锋利、有压迫感`
- `克制、有判断力`

## 9.4 该树落盘

- `style-profile.json`
  - `writingPreferences.*`
- overlay skill
  - 所有具体写作规则
- `CreatorProfile.md`
  - 只记录高层风格方向，不记录细节规则
- `user.md`
  - 只记录用户长期偏好摘要

## 10. 逻辑树六：协作方式树

这棵树只决定 RedClaw 怎么和用户互动，不决定文案写法。

### 10.1 一级判断

题目名称：`你希望我在协作中更像哪种搭档`

选项：

- `高执行、少废话`
- `强结构、像策略顾问`
- `直接批判、帮你把问题挑出来`
- `温和陪跑、边做边校正`

### 10.2 二级判断

题目名称：`当你给的方向有问题时，我应该`

选项：

- `直接指出问题并给替代方案`
- `先解释风险，再给建议`
- `除非明显错误，否则先按你要求执行`

### 10.3 该树落盘

- `Soul.md`
  - 协作语气
  - 反馈方式
  - 决策风格
- `style-profile.json`
  - `collaborationPreferences.*`

## 11. 问题树的执行顺序

推荐完整顺序：

1. 空间目标树
2. 经营模式树
3. 受众与关系树
4. 品牌与内容策略树
5. 文案风格心理测试树
6. 协作方式树
7. 结果确认页

结果确认页必须展示：

- 空间模式摘要
- 经营路径摘要
- 受众关系摘要
- 品牌方向摘要
- 写作风格摘要
- 协作方式摘要

用户必须能看到“你将长期按什么规则被服务”，而不是只看到“已完成设置”。

## 12. 结构化字段建议

建议 `style-profile.json` 至少包含以下字段：

```json
{
  "workspaceMission": {
    "primaryMode": "sales|content",
    "secondaryMode": "sales|content|null",
    "primaryMetric": "",
    "successMetrics": []
  },
  "businessModel": {
    "salesMode": "persona|brand|single_sku|matrix|service|null",
    "conversionDriver": "",
    "contentGoal": ""
  },
  "audienceModel": {
    "rolePosition": "",
    "relationshipDistance": "close|advisor|senior|brand",
    "authorityPosture": "low|medium|high"
  },
  "brandStrategy": {
    "accountArchetype": "",
    "trustSource": "",
    "consistencyVsVirality": "consistency|balanced|virality"
  },
  "writingPreferences": {
    "hookStrength": 0,
    "informationDensity": 0,
    "emotionalTemperature": 0,
    "authorityLevel": 0,
    "structurePreference": "",
    "storyRatio": 0,
    "salesExplicitness": 0,
    "sloganTolerance": 0,
    "conflictLevel": 0,
    "ctaIntensity": 0,
    "firstPersonRatio": 0
  },
  "collaborationPreferences": {
    "executionStyle": "",
    "feedbackDirectness": 0,
    "challengeLevel": 0
  }
}
```

## 13. 文档与 skill 的投影规则

## 13.1 `Soul.md`

只投影：

- 协作风格
- 反馈力度
- 执行偏好

禁止投影：

- 标题规则
- 开头规则
- CTA 规则

## 13.2 `user.md`

只投影：

- 用户核心目标
- 受众画像
- 内容赛道
- 成功指标
- 长期偏好摘要

摘要可以写：

- 偏好高信息密度、冷静、少口号化表达

但不写：

- 开头必须两句内给结论

## 13.3 `CreatorProfile.md`

只投影：

- 空间定位
- 经营目标
- 品牌方向
- 受众关系
- 长期风格方向
- 商业边界

可以写：

- 长期内容风格偏冷静、判断型、实用导向

但不写：

- 标题必须控制在冲突式句法

## 13.4 overlay skill

这才是所有可执行写作规则的归宿。

建议文件：

- `desktop/skills/redclaw-writing-style-profile/SKILL.md`

建议结构：

```md
# RedClaw Writing Style Profile

## Role

## Scope

## High Priority Rules

## Opening Strategy

## Title Strategy

## Body Structure

## Tone And Cadence

## Sales Expression Rules

## Forbidden Patterns

## Self Check
```

## 14. 后续学习与更新规则

初始化只是第一版。

后续真实对话中，以下语句可触发风格增量更新候选：

- `这个太像营销号了`
- `再克制一点`
- `不要这么像老师讲课`
- `标题太弱`
- `不要那么强推销`
- `这种表达很好，以后都按这个来`

但更新流程不能直接写文档，必须走：

1. 抽取增量偏好
2. 判断属于哪一层
3. 合并到 `style-profile.json`
4. 重新投影到文档和 overlay skill

## 15. 初始化结果确认页建议

在首轮完成后，不要只给一句“设定完成”。

必须给出结构化确认摘要：

### 15.1 空间经营模式

- 主模式：销售导向
- 次模式：内容铺垫
- 经营方式：人设带货

### 15.2 受众关系

- 用户希望受众把账号视为：有判断力的前辈
- 距离感：专业但不过度疏离

### 15.3 写作风格

- 开头：判断先行，但避免夸张
- 信息密度：偏高
- 情绪温度：偏冷静
- CTA：中等偏弱

### 15.4 协作方式

- RedClaw 以后默认：高执行、强结构、直接指出问题

用户必须能选择：

- `确认采用`
- `改几个点`
- `重新做风格测试`

## 16. 验证要求

这套初始化流程如果后续执行，最低验证矩阵必须包含：

### 16.1 档案验证

- 完成问卷后，`Soul.md / user.md / CreatorProfile.md` 各自只出现本职责字段
- 不允许写作细则污染 `Soul.md`
- 不允许协作语气污染 overlay skill

### 16.2 skill 验证

- 写作任务运行时同时加载 builtin `writing-style` 与 workspace overlay skill
- 非写作任务不应让 overlay skill 干扰决策

### 16.3 行为验证

- 同一份初始化结果生成标题、正文、CTA 时风格一致
- 当用户后续说“以后都按这种写法来”时，能正确更新 canonical profile

## 17. 推荐结论

这个初始化流程不应该被当成“问几个偏好题”。

它本质上是：

- 一套经营目标识别树
- 一套内容与销售模式判断树
- 一套基于文案样例的风格心理测试树
- 一套长期档案和执行 skill 的投影系统

如果后续按这份方案落地，最关键的执行原则只有两个：

1. 先判定空间怎么经营，再判定内容怎么写。
2. 让文档记忆长期事实，让 skill 约束真实写作。

