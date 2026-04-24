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
  - 首次初始化从线性问答升级为混合题型逻辑树
  - 内容与商业等混合目标使用连续权重建模而不是二选一
  - 风格初始化结果可稳定投影到 Soul.md、user.md、CreatorProfile.md 与写作风格 overlay skill
  - 后续真实创作纠偏可以沿用同一字段体系增量更新
---

# RedClaw 首次风格初始化混合题型方案

## 1. 目标

这份方案用于重构 `RedClaw` 在一个空间第一次启动、第一次进入 AI 创作对话时的初始化流程。

目标不是做一组普通问卷，而是做一套能逼近真实经营状态的混合式测试：

- 用 `滑杆` 表达连续权重
- 用 `单选/多选` 表达业务模式
- 用 `A/B 文案题` 表达真实写法偏好
- 用 `补充校准题` 解释滑杆含义和冲突

最终需要把结果稳定拆分写入：

- `Soul.md`
- `user.md`
- `CreatorProfile.md`
- workspace 级写作风格 overlay skill
- `style-profile.json` 作为 canonical source

## 2. 核心判断

上一版方案的主问题是：虽然已经引入逻辑树，但很多问题仍然默认用户可以明确单选。

这不符合真实账号状态。

大多数空间都同时包含：

- 内容目标
- 商业目标
- 人设经营
- 品牌经营
- 专业表达
- 传播表达

这些不是互斥关系，而是比例关系。

因此初始化流程的主骨架应该从“树状单选问卷”升级为：

1. `连续权重层`
2. `模式归类层`
3. `文案偏好层`
4. `冲突校准层`

## 3. 设计原则

### 3.1 连续问题用滑杆，不强行二选一

适合用滑杆的问题有三个特征：

- 两端都可能成立
- 用户真实状态通常在中间
- 后续执行需要强度值，而不是类别值

例如：

- 内容 vs 商业
- 人设 vs 品牌
- 冷静 vs 热烈
- 专业感 vs 亲近感
- 弱转化 vs 强转化

### 3.2 业务模式问题仍然必须分类

以下问题不能用滑杆替代：

- 人设带货 / 品牌带货 / 单品爆款 / 服务转化
- 账号角色定位
- 主要内容体裁
- 主要受众关系

因为这些问题决定的是策略分支，不是程度。

### 3.3 风格偏好必须看样例，不只看形容词

创作风格的真正判断仍然要靠 `A/B 文案样例`。

原因是：

- 用户会误用形容词
- 同一个词每个人理解不同
- 文案偏好最终要作用在真实成稿上

所以：

- 滑杆负责定大方向和权重
- 分类题负责定模式
- A/B 题负责定写法

### 3.4 滑杆值必须配“含义校准题”

例如用户选：

- 内容 70 / 商业 30

这个值本身不够执行。

还必须再问：

- 这个比例主要体现在什么地方

否则同一个数值可能被错误解释为：

- 发布配比
- 单篇内容内部配比
- 长期经营重心
- 选题优先级

### 3.5 文档与 skill 仍然严格分责

这次只是重做题型，不改变职责边界。

- `Soul.md`：RedClaw 如何协作
- `user.md`：用户事实与长期偏好摘要
- `CreatorProfile.md`：空间长期经营策略
- `redclaw-writing-style-profile`：具体写作执行规则
- builtin `writing-style`：通用底盘，不承载用户个性化

## 4. 总体架构

## 4.1 输出层级

初始化流程必须产出五层结果：

1. `raw_answers`
2. `structured_profile`
3. `document_projection`
4. `skill_projection`
5. `runtime_summary`

其中：

- `raw_answers` 保存原始回答、滑杆值、A/B 选择和补充说明
- `structured_profile` 是唯一真源
- `document_projection` 负责文档
- `skill_projection` 负责 overlay skill
- `runtime_summary` 负责后续 prompt 注入

## 4.2 canonical source

建议新增：

- `redclaw/profile/style-profile.json`

建议主结构：

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

## 4.3 初始化流程分层

完整流程不再叫“6 棵树”，而是 4 层 9 组问题：

1. `权重滑杆层`
2. `模式分类层`
3. `A/B 文案测试层`
4. `冲突校准层`

## 5. 题型系统

## 5.1 滑杆题

适合：

- 连续权重
- 强度
- 经营取向

输出：

- `0-100` 数值
- 两端锚点说明
- 一段自动解释文本

## 5.2 单选/多选题

适合：

- 经营模式
- 账号类型
- 体裁偏好
- 受众关系

输出：

- `enum`
- `enum[]`

## 5.3 A/B 文案题

适合：

- 开头方式
- 信息密度
- 情绪温度
- 销售显性度
- 结构感

输出：

- 某个风格维度偏向
- 强度分

## 5.4 校准题

适合：

- 解释滑杆的真实含义
- 解决冲突
- 把抽象偏好转成可执行规则

输出：

- `scope`
- `priority`
- `tie_break`

## 6. 第一层：权重滑杆层

这一层负责快速定义空间的大方向。

建议首轮就问 6 个滑杆。

## 6.1 滑杆一：内容 vs 商业

题目：

`这个空间整体更偏内容，还是更偏商业？`

滑杆：

- `0 = 纯内容导向`
- `100 = 纯商业导向`

中间文案建议：

- `0-20`：强内容导向，优先停留、收藏、关注
- `21-40`：内容优先，允许轻商业
- `41-60`：内容与商业平衡
- `61-80`：商业优先，但仍需要内容包装
- `81-100`：强商业导向，优先成交效率

必须追加校准题：

`这个比例主要体现在哪？`

选项：

- `账号长期经营目标`
- `内容发布配比`
- `单篇文案内部配比`
- `选题优先级`

落盘：

- `style-profile.json.workspaceMission.contentVsCommerce`
- `style-profile.json.workspaceMission.contentVsCommerceScope`
- `user.md` 摘要
- `CreatorProfile.md` 经营策略

## 6.2 滑杆二：人设 vs 品牌

题目：

`这个空间更依赖经营“你这个人”，还是经营“品牌本身”？`

滑杆：

- `0 = 完全品牌驱动`
- `100 = 完全人设驱动`

中间解释：

- 值越高，越依赖个人经历、观点、筛选能力
- 值越低，越依赖品牌定位、一致性、产品体系

追加校准题：

`如果必须优先放大一个信任来源，你更想放大哪一个？`

- `你这个人的判断`
- `品牌本身的稳定性`
- `产品的实际效果`

落盘：

- `businessModel.personaVsBrand`
- `brandStrategy.trustSource`
- `CreatorProfile.md`

## 6.3 滑杆三：长期一致性 vs 短期爆发力

题目：

`这个空间更应该追求长期一致性，还是短期爆发力？`

滑杆：

- `0 = 一致性优先`
- `100 = 爆发力优先`

落盘：

- `brandStrategy.consistencyVsVirality`

## 6.4 滑杆四：专业感 vs 亲近感

题目：

`你更希望账号整体给人的感觉是专业判断，还是亲近自然？`

滑杆：

- `0 = 亲近自然`
- `100 = 专业判断`

落盘：

- `audienceModel.authorityPosture`
- `writingPreferences.authorityLevel`

## 6.5 滑杆五：冷静克制 vs 情绪感染

题目：

`文案整体更应该冷静克制，还是更有情绪感染力？`

滑杆：

- `0 = 极冷静`
- `100 = 强感染`

落盘：

- `writingPreferences.emotionalTemperature`

## 6.6 滑杆六：弱转化 vs 强转化

题目：

`内容里的转化表达应该多隐性，还是多显性？`

滑杆：

- `0 = 基本不直接转化`
- `100 = 明确推动行动`

追加校准题：

`这个强度主要应该体现在哪？`

- `结尾 CTA`
- `中间产品露出`
- `选题本身`
- `案例和证据组织方式`

落盘：

- `writingPreferences.salesExplicitness`
- `writingPreferences.ctaIntensity`
- `writingPreferences.conversionPlacement`

## 7. 第二层：模式分类层

这一层在滑杆之后，用来确定策略分支。

## 7.1 经营模式题

题目：

`这个空间最接近哪一种经营方式？`

单选：

- `人设带货`
- `品牌带货`
- `单品爆款`
- `店铺矩阵`
- `高客单服务转化`
- `纯内容账号`
- `内容优先、后续转化`

落盘：

- `businessModel.primaryModel`
- `CreatorProfile.md`

## 7.2 账号角色题

题目：

`你希望受众主要把你视为什么角色？`

单选：

- `专业顾问`
- `有经验的过来人`
- `真实试错者`
- `主理人`
- `高审美创作者`

落盘：

- `audienceModel.rolePosition`
- `CreatorProfile.md`

## 7.3 受众距离题

题目：

`你和受众之间更接近哪种关系？`

单选：

- `朋友式`
- `前辈式`
- `顾问式`
- `品牌主理人式`

落盘：

- `audienceModel.relationshipDistance`

## 7.4 主要体裁题

题目：

`这个空间最常见的核心内容体裁是什么？`

多选，最多 2 项：

- `教程拆解`
- `案例复盘`
- `观点表达`
- `体验测评`
- `清单推荐`
- `故事叙事`

落盘：

- `writingPreferences.primaryFormats`
- `user.md`

## 8. 第三层：A/B 文案测试层

这层才真正决定“怎么写”。

默认不要一次测 10 个维度。

建议首轮固定做 6 组，后面按前两层结果动态追加 2-4 组。

## 8.1 固定必做的 6 组

1. 开头钩子强度
2. 信息密度
3. 情绪温度
4. 权威姿态
5. 结构方式
6. 第一人称比例

## 8.2 销售导向追加组

当 `内容 vs 商业` 大于 55 或经营模式偏销售时，追加：

1. 销售显性程度
2. CTA 强度
3. 产品证据组织方式

## 8.3 内容导向追加组

当 `内容 vs 商业` 小于 45 或模式偏内容时，追加：

1. 金句容忍度
2. 叙事比例
3. 冲突表达强度

## 8.4 A/B 题样例设计

### 8.4.1 开头钩子强度

题目：

`下面两种开头，你更愿意长期采用哪一种？`

A：

> 很多人以为卖不动，是流量不够。  
> 但多数时候，问题根本不在流量。

B：

> 这周我重新看了 37 条转化不错的内容。  
> 最后发现，真正影响成交的不是你想的那个点。

映射：

- A 更强钩子
- B 更观察式开头

字段：

- `writingPreferences.hookStrength`
- `writingPreferences.openingStyle`

### 8.4.2 信息密度

A：

> 一篇能转化的内容，至少要同时解决三个问题：谁会停、为什么信、凭什么下单。

B：

> 内容能不能转化，先别想太复杂。  
> 你先想清楚一件事：别人凭什么信你。

字段：

- `writingPreferences.informationDensity`

### 8.4.3 情绪温度

A：

> 我以前也很烦这种空话，所以后来写内容时，先把那些假热闹都删了。

B：

> 这类内容最大的价值，不是热闹，而是能不能留下真正有判断力的用户。

字段：

- `writingPreferences.emotionalTemperature`
- `writingPreferences.selfExposureLevel`

### 8.4.4 权威姿态

A：

> 如果你现在还在靠“多发一点”解决问题，方向大概率已经偏了。

B：

> 如果你也遇到过这种情况，可以先检查是不是把节奏问题误判成了流量问题。

字段：

- `writingPreferences.authorityLevel`

### 8.4.5 结构方式

A：

> 我只看三件事：内容有没有切中人、有没有留下判断、有没有给出行动理由。

B：

> 先说一个场景。  
> 然后你就会明白，为什么很多内容看起来热闹，最后却没人行动。

字段：

- `writingPreferences.structurePreference`
- `writingPreferences.storyRatio`

### 8.4.6 第一人称比例

A：

> 我后来发现，很多“经验分享”其实只是在重复套路。

B：

> 经验型内容最容易出问题的地方，是把套路当成判断。

字段：

- `writingPreferences.firstPersonRatio`

### 8.4.7 销售显性程度

A：

> 如果你本来就在做这个品类，这条内容可以直接改成你的成交前置脚本。

B：

> 先把内容写对，转化这件事后面才有资格谈。

字段：

- `writingPreferences.salesExplicitness`

### 8.4.8 CTA 强度

A：

> 如果你也在做这类内容，先把这套判断框架存下来再改稿。

B：

> 这类问题后面我还会继续拆，先记住今天这个判断就够了。

字段：

- `writingPreferences.ctaIntensity`

### 8.4.9 金句容忍度

A：

> 真正能卖出去的内容，不是更会说，而是更会让人信。

B：

> 内容有没有用，不在于句子响不响，而在于别人看完会不会改动作。

字段：

- `writingPreferences.sloganTolerance`

### 8.4.10 冲突表达强度

A：

> 最大的问题不是你不会写，而是你一直在写没人在乎的东西。

B：

> 很多时候，不是不会写，而是选题和用户在意的问题没有对上。

字段：

- `writingPreferences.conflictLevel`

## 9. 第四层：冲突校准层

这层只在必要时触发，不是所有人都做满。

## 9.1 滑杆含义校准

适用场景：

- 内容/商业
- 人设/品牌
- 弱转化/强转化

目标：

- 判断该值影响发布配比、单篇内容，还是长期经营目标

## 9.2 冲突校准

适用场景：

- 用户选了 `冷静克制`
- 但又多次选 `强冲突、强情绪、强 CTA`

校准题示例：

`如果只能保留一种第一印象，你更希望内容是：`

- `锋利、有压迫感`
- `克制、有判断力`

## 9.3 极端值校准

适用场景：

- 多个滑杆同时打满两端

示例：

- 内容/商业 90
- 强转化 95
- 但又要求长期信任和高留存

校准题：

`当传播效率和信任感冲突时，你默认优先保哪个？`

- `传播效率`
- `信任感`
- `看具体内容`

## 10. 推荐问卷顺序

建议真正上线时控制在 3 个阶段展示，而不是一次把所有题铺开。

### 阶段一：经营重心

- 内容 vs 商业
- 人设 vs 品牌
- 一致性 vs 爆发力
- 经营模式分类

### 阶段二：账号关系

- 专业感 vs 亲近感
- 角色定位
- 受众距离
- 主要体裁

### 阶段三：文案写法

- 冷静 vs 情绪
- 弱转化 vs 强转化
- 6 组固定 A/B
- 动态追加 A/B
- 冲突校准

### 结尾：协作方式

协作方式保留一组轻量题，不放到风格测试中间。

题目：

`你希望我更像哪种搭档？`

- `高执行`
- `强结构`
- `直接批判`
- `温和陪跑`

这组结果只落：

- `Soul.md`
- `collaborationPreferences`

## 11. 各层结果如何落盘

## 11.1 `Soul.md`

只写：

- 协作语气
- 反馈方式
- 决策风格

不写：

- 标题规则
- CTA 规则
- 段落结构

## 11.2 `user.md`

只写：

- 用户核心目标
- 受众画像
- 主要体裁
- 经营偏好摘要
- 成功指标

可以写：

- 这个空间内容与商业并行，但内容略优先

不写：

- 结尾 CTA 要多强

## 11.3 `CreatorProfile.md`

只写：

- 空间定位
- 经营模式
- 信任来源
- 品牌方向
- 爆发与一致性的取舍
- 长期风格方向

可以写：

- 长期偏向冷静、专业、判断型内容表达

不写：

- 开头必须先打判断句

## 11.4 overlay skill

这是所有写作执行细则的唯一归宿。

建议文件：

- `desktop/skills/redclaw-writing-style-profile/SKILL.md`

建议内容结构：

1. `High Priority Rules`
2. `Opening Strategy`
3. `Title Strategy`
4. `Body Structure`
5. `Tone And Cadence`
6. `Sales Expression Rules`
7. `Forbidden Patterns`
8. `Self Check`

## 12. 结构化字段建议

```json
{
  "workspaceMission": {
    "contentVsCommerce": 0,
    "contentVsCommerceScope": "",
    "primaryMetric": "",
    "successMetrics": []
  },
  "businessModel": {
    "primaryModel": "",
    "personaVsBrand": 0,
    "conversionDriver": ""
  },
  "audienceModel": {
    "rolePosition": "",
    "relationshipDistance": "",
    "authorityPosture": 0
  },
  "brandStrategy": {
    "consistencyVsVirality": 0,
    "trustSource": "",
    "accountArchetype": ""
  },
  "writingPreferences": {
    "emotionalTemperature": 0,
    "salesExplicitness": 0,
    "ctaIntensity": 0,
    "conversionPlacement": "",
    "hookStrength": 0,
    "openingStyle": "",
    "informationDensity": 0,
    "authorityLevel": 0,
    "structurePreference": "",
    "storyRatio": 0,
    "firstPersonRatio": 0,
    "sloganTolerance": 0,
    "conflictLevel": 0,
    "primaryFormats": []
  },
  "collaborationPreferences": {
    "executionStyle": "",
    "feedbackDirectness": 0,
    "challengeLevel": 0
  }
}
```

## 13. 初始化结果确认页

完成后不能只显示“已完成设置”。

必须给出结构化摘要：

- 内容/商业：`内容 65 / 商业 35`
- 人设/品牌：`人设 70 / 品牌 30`
- 一致性/爆发力：`一致性 60 / 爆发力 40`
- 账号角色：`专业顾问型`
- 受众关系：`顾问式，距离适中`
- 写法摘要：
  - 开头偏观察式
  - 信息密度偏高
  - 情绪温度偏冷静
  - 转化表达中等偏弱
- 协作方式：
  - 高执行
  - 强结构

并提供三个动作：

- `确认采用`
- `修改几个关键值`
- `重做文案偏好测试`

## 14. 后续学习规则

初始化不是终局，后续纠偏要继续复用同一字段体系。

可视为增量证据的表达包括：

- `这个太像营销号了`
- `以后 CTA 再弱一点`
- `这种观察式开头更适合我`
- `别总写成很像老师上课`
- `这种更像我的账号，以后都按这个来`

这些都不应直接改 Markdown，而应走：

1. 提取偏好 patch
2. 合并到 `style-profile.json`
3. 重新投影到文档和 overlay skill

## 15. 推荐结论

这套初始化流程的最优设计，不是“树状单选问卷”，也不是“全靠文案 A/B”。

最优解是混合题型：

- `滑杆` 定权重
- `分类题` 定模式
- `A/B 文案题` 定写法
- `校准题` 解歧义

对 RedClaw 来说，最关键的不是问得多，而是让每个答案都有明确归宿：

- 经营重心进 `CreatorProfile.md`
- 用户事实进 `user.md`
- 协作方式进 `Soul.md`
- 真实写作规则进 overlay skill

只有这样，初始化结果才能真的成为长期可执行的创作规范，而不是一堆不好用的偏好描述。

