---
name: redbox-image-director
description: Use when planning and generating a coordinated batch of multiple images in RedBox. First identify the user's motive and final goal, then choose the right image-set type and ordering strategy, lock the batch-level subject anchor, keep the style guide concise, define text placement and image details for each card, then call app_cli(action="image.generate", payload={ ... }) with the correct execution contract for the current runtime.
allowedRuntimeModes: [chatroom, redclaw, image-generation]
allowed-tools: app_cli
activationScope: turn
autoActivate: false
hookMode: inline
---

# RedBox Image Director

Use this skill only for multi-image work.

If the user needs just one image, do not use this workflow.

## When To Use

Use this skill when the request implies a coordinated image set, for example:

- 一次生成多张配图
- 小红书组图 / 轮播图 / 多卡封面
- 连续步骤图 / 场景序列图
- 同一主体、同一风格下的多张海报或插图

## Planning Priorities

When planning a batch, follow this priority order:

1. Determine the user's motive and the set's business/content goal first.
2. Lock subject consistency second.
3. Lock the shared style direction third.
4. Spend the most detail on visible text, layout positions, and image-level visual details.

This means:

- 先决定这套图是为了吸引点击、解释知识、展示产品，还是促进转化
- 主体一致性高于“每张都很花哨”
- 套图统一感高于单张炫技
- 细节说明高于冗长风格辞藻

Do not treat style language as the main payload.
Modern image models usually already produce decent aesthetics from a short style anchor.
Use the extra detail budget on identity consistency, composition constraints, text content, text position, product placement, props, background details, and must-keep visual cues.

## Core Mission

The core mission of this skill is:

1. Determine the exact content details of every image.
2. Ensure the whole set stays visually unified and never feels fragmented.

If a planning choice makes the set harder to read, weaker in sequence, or more visually inconsistent, reject that choice and rebuild the plan.

## Motive-Driven Planning

Do not plan image sets only by counting image quantity.
Always infer the user's motive first, then choose the set type and sequence logic that best serves that motive.

Typical motive buckets:

- 吸引点击 / 提升停留：先强钩子，再递进信息
- 讲清知识 / 降低理解成本：先结论，再拆解，再总结
- 展示产品 / 场景种草：先主视觉，再卖点，再场景，再收束
- 促进转化 / 电商成交：先抓注意，再建信任，再给利益点，再推动行动
- 连续叙事 / 漫画表达：先设定，再冲突或问题，再过程，再落点

When the user does not explicitly name the set type, infer it from the motive, platform, and content form.
If the platform is 小红书, default to content forms that match 小红书 consumption patterns instead of generic image batches.

## Supported Set Types

This skill should be able to organize at least these common set types:

- 小红书文字卡片
- 小红书配图
- 知识图解漫画
- 知识卡片套图
- 电商配图

You may also adapt to adjacent variants when needed, but do not lose the sequence logic.

## Set Type Playbooks

### 小红书文字卡片

Best for:

- 观点表达
- 干货提炼
- 情绪共鸣
- 经验总结

Recommended order logic:

1. 封面钩子
2. 核心观点 / 结论
3. 论据 / 拆解
4. 补充要点 / 反常识点
5. 总结 / 互动引导

Planning focus:

- 文字信息层级必须非常清楚
- 每张卡片只承载一个核心点
- 版式、字号层级、标题位置、装饰元素整套统一

### 小红书配图

Best for:

- 口播文案配图
- 生活方式表达
- 经验型内容辅助理解
- 轻种草

Recommended order logic:

1. 封面主视觉
2. 核心场景 / 核心动作
3. 补充细节 / 局部特写
4. 对比 / before-after / 使用状态
5. 收尾氛围图或总结图

Planning focus:

- 人物、产品、场景调性必须统一
- 每张图对应文案段落，不要出现内容错位
- 画面变化要服务内容推进，而不是随机换场景

### 知识图解漫画

Best for:

- 解释概念
- 拆解机制
- 用角色降低理解门槛

Recommended order logic:

1. 问题提出
2. 角色引入 / 情境建立
3. 核心机制拆解
4. 例子 / 对比 / 误区
5. 结论收束

Planning focus:

- 角色外观、表情体系、服装、线条风格必须稳定
- 每格只推进一步认知，不要一张塞满全部信息
- 对话框、标注、箭头、知识标签的位置必须提前写清

### 知识卡片套图

Best for:

- 知识清单
- 方法步骤
- 认知框架
- 学习总结

Recommended order logic:

1. 标题页 / 结论页
2. 概念定义
3. 关键要点 1
4. 关键要点 2
5. 应用 / 注意事项 / 复盘

Planning focus:

- 信息结构比装饰重要
- 每张卡片的标题、图标、示意元素要有统一规范
- 要明确哪些内容适合图示，哪些内容只适合短句

### 电商配图

Best for:

- 商品卖点展示
- 场景种草
- 功能对比
- 转化型详情图

Recommended order logic:

1. 抓眼主图 / 核心卖点
2. 产品关键功能
3. 使用场景
4. 细节特写 / 材质 / 参数
5. 信任补强 / 对比 / 行动引导

Planning focus:

- 产品外观、比例、材质、颜色不能漂移
- 文字必须直接服务转化，不写空泛形容词
- 要提前写清产品在画面中的位置、大小、出镜方式和陪衬物

## Default Workflow

Before any multi-image `app_cli(action="image.generate", payload={ ... })` call:

1. Identify the user's motive, platform, set type, required image count, intended order, and final usage.
2. Choose the sequence strategy that best matches that motive and set type.
3. Write one concise shared consistency guide for the whole batch.
4. Draft an image plan as a Markdown table with explicit text placement and must-keep details.
5. In normal runtimes, show the plan to the user and wait for confirmation.
6. In `redclaw` runtime, if the user clearly asked for a card-set batch such as `知识卡片 / 图文卡片 / 小红书文字卡片`, do not stop for a second confirmation after planning; continue in the same turn.
7. Then call `app_cli(action="image.generate", payload={ ... })` once for the whole batch.

## Required Planning Output

Show the plan as a Markdown table with these columns:

| 顺序 | 图片标题 | 画面目标 | 文字与位置 | 主体与细节约束 |
| --- | --- | --- | --- | --- |

Also provide one short shared style guide above or below the table.

The plan must make these things explicit:

- what user motive this image set is serving
- what set type has been selected
- why this order fits that motive
- each image's order in the batch
- what visual role each image plays
- what exact text/copy appears on that image
- where the text should appear and how prominent it should be
- which subject features and visual details must stay unchanged
- what must stay consistent across all images

## Shared Style Guide

The shared style guide should lock the batch-level constants, but stay concise.

- 主体身份 / 产品外观 / 关键道具 / 不可漂移的识别点
- 服装、发型、材质、品牌元素、色彩系统
- 光线逻辑、镜头语言、背景密度
- 画面整体气质，用一句短风格描述即可

Do not rewrite the style from scratch for each image.
Keep one stable anchor and only vary the shot-specific content.
Do not over-describe the aesthetic with long adjective chains unless the user explicitly asks for a very specific art direction.

Prefer a short style anchor like:

- `现代广告感，干净高级，真实摄影质感`
- `扁平插画，明快配色，轻松生活方式`
- `杂志封面感，克制留白，轻复古`

Then move the detail budget into:

- 标题、副标题、角标、按钮文案的准确内容
- 标题在上 / 中 / 下，居左 / 居中 / 居右
- 主体站位、产品摆放位置、前景和背景元素
- 必须出现或禁止出现的局部细节
- 哪些视觉元素要整套重复出现，哪些只在单张变化

## Confirmation Rule

In normal runtimes, after showing the table, ask for confirmation.

Example:

- `请确认这组图片方案。我确认后会一次性并发生成整组图片。`

If the user changes the order, copy, or any image content, revise the table first and wait again.

RedClaw exception:

- If current runtime is `redclaw` and the request is already an explicit card-set generation task, do not ask for a second confirmation.
- In that case, finish the plan and call `image.generate` in the same turn with:
  - `planExecutionMode: "redclaw_auto_execute"`
  - `setType: "knowledge_card_set" | "image_card_set" | "xiaohongshu_text_cards"`
  - `sequenceGoal`
  - `sharedStyleGuide`
  - `imagePlanItems`

## Tool Call Contract

After the user confirms, call:

`app_cli(action="image.generate", payload={ ... })`

The payload should include:

- `prompt`: the overall batch brief
- `count`: total image count
- `planConfirmed`: `true` in normal confirmation flow
- `planExecutionMode`: `user_confirmed` by default; `redclaw_auto_execute` for RedClaw card-set auto execution
- `setType`: the selected image set type
- `sequenceGoal`: the ordering logic for the batch
- `sharedStyleGuide`: one concise shared subject-and-style anchor for the whole batch
- `imagePlanItems`: one object per image, in final order

Recommended `imagePlanItems` shape:

```json
[
  {
    "title": "封面",
    "prompt": "人物正面主视觉，突出产品和主题钩子，主体服装和产品外观必须与全套保持一致，标题在左上，卖点角标在右上",
    "copy": "主标题：7天养成冷白皮；副标题：真实实测；角标：干货版"
  },
  {
    "title": "第二张",
    "prompt": "补充核心卖点或步骤画面，继续使用同一主体和同一色彩系统，产品放在画面下方偏右，保留统一标题样式",
    "copy": "标题：先看成分；正文短句：这3种成分更关键"
  }
]
```

When reference images exist, still pass them through `referenceImages` or `subjectIds`.

## Hard Rules

- Do not call multi-image generation before confirmation in normal runtimes.
- In `redclaw` runtime, only skip the extra confirmation when the request is an explicit supported card-set task and you pass `planExecutionMode=redclaw_auto_execute` with a valid `setType`.
- Do not collapse a multi-image request into one generic prompt repeated N times.
- Do not choose image order randomly; sequence must match the user's motive and set type.
- Do not let one batch image drift into a different subject, color system, outfit, product shape, or rendering style.
- Do not silently change the requested order.
- If batch consistency is the main goal, prefer stable composition and repeatable visual language over flashy variation.
- When there is a tradeoff, reduce style flourish before reducing subject consistency or text/layout precision.

## Execution Note

Once the approved batch payload is submitted, the host can fan out the image requests concurrently.
Your job is to make the approved order, per-image content, and shared style contract explicit before that call happens.
