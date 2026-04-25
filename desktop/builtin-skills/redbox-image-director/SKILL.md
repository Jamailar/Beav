---
name: redbox-image-director
description: Use when the user wants to做一整套图片、组图、卡片图、轮播图、配图包或电商套图 in RedBox. First identify the user's motive and final goal, then choose the right image-set type and ordering strategy, lock the batch-level subject anchor, keep the style guide concise, define text placement and image details for each card, and always show the full batch plan to the user first. Only after the user explicitly agrees may you call Redbox(resource="image", operation="generate", input={ ... }) for batch generation. Never submit multi-image generation without user approval.
allowedRuntimeModes: [chatroom, redclaw, image-generation]
allowed-tools: Redbox
activationScope: turn
autoActivate: false
activationHint: 当用户要做文章卡片、图解卡片、演示卡片、小红书图文卡片、知识卡片、电商套图、商品套图、商品详情图、组图、轮播图、多卡配图时，先调用 `Redbox(resource="skill", operation="run", input={ "name": "redbox-image-director" })`。只要最终交付物是成套图片，而不是正文写稿，就优先本技能；不要只因为输入里出现“文章”“内容”“标题”就先启用 writing-style。
contextNote: 这是 RedBox 的多图编排技能。凡是“把文章/内容做成卡片图、图解卡片、演示卡片、电商套图、轮播图、组图”的任务，优先由它决定套图类型、顺序、统一风格锚点与每张图的文案位置；只有当用户额外要求改写正文或重写文案时，才考虑叠加 writing-style。
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
- 把文章做成卡片 / 把内容改成图文卡片
- 做图解卡片 / 知识卡片 / 图文卡片 / 演示卡片
- 做电商套图 / 商品套图 / 商品详情图 / 转化配图

## 中文触发词与入口词

看到下面这些中文表达时，应优先判断是否进入本技能，而不是把它当成单张图片任务：

- `电商套图` / `商品套图` / `商品配图` / `商品详情图` / `电商配图`
- `文章卡片` / `文章改卡片` / `把文章做成卡片` / `图文卡片`
- `图解卡片` / `知识卡片` / `知识图解` / `拆解卡片`
- `演示卡片` / `小红书演示卡片` / `演示图文` / `轮播演示卡`
- `组图` / `多张图` / `多卡` / `轮播图` / `成套配图`

这些入口词的默认归类如下：

- `电商套图` -> `电商配图`
- `文章卡片` -> 优先归到 `知识卡片套图` 或 `小红书文字卡片`，根据文章是否以观点表达为主来判断
- `图解卡片` -> 优先归到 `知识卡片套图`；如果明显要求角色化、分镜化解释，可归到 `知识图解漫画`
- `演示卡片` -> 归到 `小红书文字卡片` 或演示型轮播卡片，重点是步骤展示、卖点演示、前后对比或操作过程

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
3. Produce a clear batch plan for user review before any multi-image generation call happens.
4. Wait for explicit user approval before calling `image.generate`.

If a planning choice makes the set harder to read, weaker in sequence, or more visually inconsistent, reject that choice and rebuild the plan.

Approval rule, repeated on purpose:

- 先出图片编排方案，再等用户明确同意，最后才能批量生成。
- 没有用户明确同意时，不允许擅自调用 `Redbox(resource="image", operation="generate", input={ ... })`。
- “我已经理解需求” 不算确认；必须是用户明确表示同意方案后，才能进入生成。

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
- 文章卡片（通常归入 `知识卡片套图` 或 `小红书文字卡片`）
- 图解卡片（通常归入 `知识卡片套图` 或 `知识图解漫画`）
- 演示卡片（通常归入 `小红书文字卡片` 的演示型变体）
- 电商套图（归入 `电商配图`）

You may also adapt to adjacent variants when needed, but do not lose the sequence logic.

## Set Type Playbooks

### 小红书文字卡片

Common Chinese asks:

- 文章卡片
- 演示卡片
- 小红书演示卡片
- 图文卡片

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

Common Chinese asks:

- 图解卡片
- 知识图解
- 拆解图
- 漫画式讲解

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

Common Chinese asks:

- 文章卡片
- 图解卡片
- 知识卡片
- 图文拆解卡

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

Common Chinese asks:

- 电商套图
- 商品套图
- 商品详情图
- 电商转化配图

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
- 电商套图必须绑定具体商品主体。合法来源只有用户上传的商品图，或主体库里可读取的商品主体；没有具体商品时，禁止继续生成电商套图

## Default Workflow

Before any multi-image `Redbox(resource="image", operation="generate", input={ ... })` call:

1. Identify the user's motive, platform, set type, required image count, intended order, and final usage.
2. Choose the sequence strategy that best matches that motive and set type.
3. Write one concise shared consistency guide for the whole batch.
4. Draft an image plan as a Markdown table with explicit text placement and must-keep details.
5. Show the plan to the user and wait for explicit confirmation.
6. Do not treat silence, implied preference, or runtime mode as confirmation.
7. Only after the user explicitly approves the plan, call `Redbox(resource="image", operation="generate", input={ ... })` once for the whole batch.

After image generation:

- Treat card generation and manuscript/project binding as two separate steps.
- By default, stop after the image/card deliverable is complete.
- Do not auto-create `.redpost` projects and do not auto-write card plans or generated card content into manuscript projects unless the user explicitly asks for project binding,稿件保存, or `.redpost` packaging as a second step.

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

## Visible Text Boundary

Card planning labels are not image content.
When planning or executing a card set, keep three fields mentally separate:

- `顺序`: internal ordering only, such as `1`, `2`, `3`, `4`.
- `图片标题`: internal asset label only, used for discussion and file/result identification.
- `文字与位置`: the only source of text that may appear inside the generated image.

Never let internal labels leak into the image.
Forbidden as visible text unless the user explicitly wrote it as the actual card copy:

- `第1页` / `第2页` / `第 1 页` / `第 2 页`
- `卡片1` / `第二张` / `封面页` / `冲突页` / `反转页` / `方法页` / `行动页`
- `冲突模型` / `方法模型` / `连续视觉` / `2/4` / `storyboard`
- `thinking_process` / `direction_frame` / `framework` / `prompt` / `layout`
- Markdown table headers, planning section names, page labels, or any explanation of your reasoning process

For Xiaohongshu card sets, visible text should be consumer-facing copy only:

- a short headline
- an optional subtitle
- short bullets, labels, button text, or diagram labels that belong to the content itself

If a phrase is only used to organize the plan, do not put it in `copy`, `visibleText`, or `compiledPrompt`.
If a phrase should be visible, write it explicitly in `文字与位置` and later in `copy` / `visibleText`.

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

After showing the table, you must ask for confirmation before any batch generation.

Example:

- `请确认这组图片方案。我确认后会一次性并发生成整组图片。`

If the user changes the order, copy, or any image content, revise the table first and wait again.

This rule is strict:

- The plan always comes first.
- User approval always comes second.
- The `image.generate` call always comes last.
- Do not skip the approval step just because the runtime is `redclaw`.
- Do not auto-submit a batch just because the plan looks complete.

## Tool Call Contract

After the user explicitly confirms, call:

`Redbox(resource="image", operation="generate", input={ ... })`

The payload should include:

- `prompt`: the overall batch brief
- `count`: total image count
- `aspectRatio`: required whenever the user specifies a ratio or format. Use `3:4` for Xiaohongshu card sets by default, `1:1` for square, `4:3` for landscape, `9:16` for vertical story/short-video cover, and `16:9` for wide landscape.
- `planConfirmed`: `true` in normal confirmation flow
- `planExecutionMode`: use `user_confirmed`
- `sequenceGoal`: the ordering logic for the batch
- `sharedStyleGuide`: one concise shared subject-and-style anchor for the whole batch
- `imagePlanItems`: one object per image, in final order

Recommended `imagePlanItems` shape:

```json
[
  {
    "title": "cover",
    "copy": "主标题：7天养成冷白皮；副标题：真实实测；角标：干货版",
    "prompt": "人物正面主视觉，突出产品和主题钩子，主体服装和产品外观必须与全套保持一致，标题在左上，卖点角标在右上",
    "compiledPrompt": "只渲染这些可见文字：主标题：7天养成冷白皮；副标题：真实实测；角标：干货版。人物正面主视觉，突出产品和主题钩子，主体服装和产品外观必须与全套保持一致，标题在左上，卖点角标在右上。不要渲染页码、卡片编号、规划标签、表格字段名或思考过程。"
  },
  {
    "title": "detail-ingredients",
    "copy": "标题：先看成分；正文短句：这3种成分更关键",
    "prompt": "补充核心卖点或步骤画面，继续使用同一主体和同一色彩系统，产品放在画面下方偏右，保留统一标题样式",
    "compiledPrompt": "只渲染这些可见文字：标题：先看成分；正文短句：这3种成分更关键。补充核心卖点或步骤画面，继续使用同一主体和同一色彩系统，产品放在画面下方偏右，保留统一标题样式。不要渲染页码、卡片编号、规划标签、表格字段名或思考过程。"
  }
]
```

Important payload rules:

- `title` must be a short internal slug or neutral asset label. Prefer `cover`, `problem`, `method`, `action`, not `第2页冲突`.
- `copy` / `visibleText` is the consumer-facing text that may appear on the image.
- `compiledPrompt` is preferred for every item. It must combine exact visible copy, layout, visual details, and a short negative instruction against page labels / planning labels / reasoning text.
- Do not rely on `title` to carry visible card copy. The generation tool may treat it as metadata, not image text.
- Do not pass `thinking_process`, outline notes, table headers, or page-plan summaries into any image item.

When reference images exist, still pass them through `referenceImages` or `subjectIds`.

## Hard Rules

- Do not call multi-image generation before confirmation in normal runtimes.
- Do not call multi-image generation before confirmation in `redclaw` runtime either.
- Do not call `image.generate` until the user has explicitly approved the batch plan.
- Do not infer approval from context, urgency, runtime mode, or previous similar tasks.
- Do not auto-submit a multi-image batch after planning, even if the plan is strong and complete.
- If the user has not approved the plan yet, stop after the plan and ask for confirmation.
- Do not render page numbers, card numbers, planning labels, table headers, framework labels, or reasoning/process text inside generated images.
- Do not use `第N页 + 规划角色` as an image item title, because models may misread it as visible text. Use neutral internal labels and put only final audience-facing text in `copy` / `visibleText`.
- Do not put sequence labels such as `冲突`, `反转`, `方法`, `行动` on the image unless the user explicitly wants those exact words as consumer-facing copy.
- Do not expose `thinking_process`, `direction_frame`, page plans, content outlines, or internal framework names in visible text.
- Do not collapse a multi-image request into one generic prompt repeated N times.
- Do not choose image order randomly; sequence must match the user's motive and set type.
- Do not let one batch image drift into a different subject, color system, outfit, product shape, or rendering style.
- Do not silently change the requested order.
- If batch consistency is the main goal, prefer stable composition and repeatable visual language over flashy variation.
- When there is a tradeoff, reduce style flourish before reducing subject consistency or text/layout precision.
- Do not auto-bind generated card sets into `.redpost` or any manuscript project unless the user explicitly requests that as a separate step.
- If the task is 电商配图 / 电商套图, you must have a concrete product source first: either user-uploaded product images or a product subject from the subject library. Without that, stop and ask for the product material instead of inventing a generic product.

## Execution Note

Once the approved batch payload is submitted, the host can fan out the image requests concurrently.
Your job is to make the approved order, per-image content, and shared style contract explicit before that call happens.
If approval has not happened yet, your job stops at planning. Do not generate first and explain later.
