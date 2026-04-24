---
name: redbox-image-director
description: Use when planning and generating a coordinated batch of multiple images in RedBox, including carousel posts, multi-card covers, ordered visual sequences, or any image set that must keep stable style and subject consistency. Build an image order table first, define each image's content and copy details plus a shared style guide, wait for user confirmation, then call app_cli(action="image.generate", payload={ ... }) once with planConfirmed, sharedStyleGuide, and imagePlanItems so the host can generate the whole batch concurrently.
allowedRuntimeModes: [chatroom, redclaw, image-generation]
allowed-tools: app_cli
activationScope: session
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

## Default Workflow

Before any multi-image `app_cli(action="image.generate", payload={ ... })` call:

1. Identify the required image count, intended order, and final usage.
2. Write one shared style guide for the whole batch.
3. Draft an image plan as a Markdown table.
4. Show the plan to the user and wait for confirmation.
5. Only after confirmation, call `app_cli(action="image.generate", payload={ ... })` once for the whole batch.

Do not skip the confirmation step.

## Required Planning Output

Show the plan as a Markdown table with these columns:

| 顺序 | 图片标题 | 画面目标 | 文案细节 |
| --- | --- | --- | --- |

Also provide one short shared style guide above or below the table.

The plan must make these things explicit:

- each image's order in the batch
- what visual role each image plays
- what text/copy detail matters for that image
- what must stay consistent across all images

## Shared Style Guide

The shared style guide should lock the batch-level constants:

- 主体身份 / 产品外观 / 关键道具
- 服装、材质、色彩系统
- 光线逻辑、镜头语言、背景密度
- 版式完成度和整体气质

Do not rewrite the style from scratch for each image.
Keep one stable anchor and only vary the shot-specific content.

## Confirmation Rule

After showing the table, ask for confirmation.

Example:

- `请确认这组图片方案。我确认后会一次性并发生成整组图片。`

If the user changes the order, copy, or any image content, revise the table first and wait again.

## Tool Call Contract

After the user confirms, call:

`app_cli(action="image.generate", payload={ ... })`

The payload should include:

- `prompt`: the overall batch brief
- `count`: total image count
- `planConfirmed`: `true`
- `sharedStyleGuide`: one stable style anchor for the whole batch
- `imagePlanItems`: one object per image, in final order

Recommended `imagePlanItems` shape:

```json
[
  {
    "title": "封面",
    "prompt": "人物正面主视觉，突出产品和主题钩子",
    "copy": "封面主标题和氛围要求"
  },
  {
    "title": "第二张",
    "prompt": "补充核心卖点或步骤画面",
    "copy": "本张需要承载的文案重点"
  }
]
```

When reference images exist, still pass them through `referenceImages` or `subjectIds`.

## Hard Rules

- Do not call multi-image generation before confirmation.
- Do not collapse a multi-image request into one generic prompt repeated N times.
- Do not let one batch image drift into a different subject, color system, or rendering style.
- Do not silently change the requested order.
- If batch consistency is the main goal, prefer stable composition and repeatable visual language over flashy variation.

## Execution Note

Once the approved batch payload is submitted, the host can fan out the image requests concurrently.
Your job is to make the approved order, per-image content, and shared style contract explicit before that call happens.
