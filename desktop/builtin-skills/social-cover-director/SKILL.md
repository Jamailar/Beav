---
name: social-cover-director
description: 'Use when the user wants to plan or generate a social media cover image for a Xiaohongshu note, Douyin/TikTok photo post, Reels/Shorts cover, WeChat/Video Account post, Bilibili/Weibo post, Pinterest pin, Instagram cover, Facebook/Meta social post, or similar creator/social content. Handles platform-native cover routing, aspect ratio, scroll-stopping hook, exact on-image copy, reference-image roles, and image.generate prompt construction for one cover or a small variant set.'
allowedRuntimeModes: [chatroom, redclaw, image-generation]
allowedTools: [workflow]
activationScope: turn
autoActivate: false
activationHint: '当用户要做小红书封面、笔记封面、社媒封面、视频封面、图文首图、Reels/TikTok/Shorts 封面、朋友圈/视频号/微博/B站/Instagram/Pinterest 等内容封面时，调用 `Operate(resource="skills", operation="invoke", input={ "name": "social-cover-director" })`。这是单张封面或少量封面变体技能；成套卡片、轮播图、商品详情图继续优先用 image-director。'
contextNote: 'social-cover-director 只负责社交媒体内容封面的点击钩子、封面文案、画面策略和生成提示词。不要把它扩成整套图文卡片规划；不要把封面制作降级成普通配图或商品白底图。'
hookMode: inline
---

# Social Cover Director

Use this skill to make one social-media cover image, or a small set of cover variants, for creator content.

It adapts the social-promo planning flow to RedBox:

```text
content/topic + platform/surface
-> reader promise + scroll-stopping hook
-> cover type + aspect ratio
-> attention mechanic + visual style pack
-> exact on-image copy
-> reference-image role map
-> image.generate prompt
-> text/identity/social-native QA
```

## Core Stance

- The cover must stop the scroll before it explains the whole content.
- Prefer a strong human-readable promise, contrast, clear subject, clean title zone, and platform-native composition.
- Do not make a catalog poster unless the user explicitly wants a product-commerce cover.
- Do not force a product, person, or logo into the cover if the stronger hook is a mood, problem scene, cultural moment, checklist, or visual metaphor.
- Exact on-image copy is a hard boundary. Use only confirmed cover text; do not let the image model invent extra labels.
- If the user wants a full carousel, multi-card note, ecommerce image set, or detail-page images, route to `image-director` instead.

## Required Inputs

Useful inputs:

- Content source: draft note, topic, title, outline, pasted article, video idea, product facts, or campaign brief.
- Platform/surface: 小红书笔记, 抖音图文, Douyin/TikTok/Reels/Shorts cover, 微信朋友圈, 视频号, 微博, B站动态, Instagram, Pinterest, Facebook/Meta.
- Market and on-image language, when not obvious.
- Reference images, when available.

If platform is missing and the content is Chinese creator content, default to 小红书笔记. If content itself is missing, ask for the topic/draft first. If only market/language is missing, infer from the user language unless the final usage seems overseas.

## Reference Loading

These references are bundled with this skill and may be used directly:

- `references/cover-routing.md`: platform, surface, aspect ratio, and variant count.
- `references/attention-design-router.md`: attention mechanics and style packs.
- `references/image-generate-prompt-contract.md`: RedBox `image.generate` prompt contract.

## Workflow

1. Extract the content promise:
   - target reader
   - core tension or curiosity
   - desired click reason
   - one thing the cover must make obvious
2. Route platform and surface.
3. Pick cover type:
   - `note_cover`
   - `short_video_cover`
   - `community_post_cover`
   - `article_cover`
   - `pin_cover`
   - `ad_cover`
   - `cover_variant_set`
4. Choose aspect ratio and count:
   - If user asks for one cover, produce one.
   - If user asks for variants, use 2-4 variants unless a platform/test brief justifies more.
   - If the current context says `noSecondConfirmation: true`, plan silently and generate after self-check.
5. Map references:
   - `subject_identity`: must preserve person/product/place identity.
   - `style_reference`: learn composition, typography, color, mood.
   - `base_image`: transform this image into a cover.
   - `content_context`: use only for understanding, not visual copying.
6. Choose one main attention mechanic and optional secondary mechanic.
7. Draft exact on-image copy:
   - one main headline
   - optional subtitle
   - optional badge/label
   - optional short proof/CTA
8. In normal chat/redclaw flow, show the Phase 1 plan and wait for confirmation before generation.
9. After confirmation, call `Operate(resource="image", operation="generate", input={ ... })`.
10. After generation, run QA and flag rerun candidates.

## Phase 1 Output

Before generation, output in Chinese:

- `封面路由判断`: platform, surface, cover type, aspect ratio, count, language.
- `内容钩子`: target reader, core tension, click promise.
- `视觉策略`: attention mechanic, style pack, subject/reference use, title safe area.
- `封面文案确认`: exact text that may appear on the image.

Use this table for one cover or variants:

```markdown
| 图 | 角色 | 吸睛机制 | 画面策略 | 图片文字（待确认） |
|---|---|---|---|---|
| 1 | primary_cover | oversized_headline + human_gaze | ... | `主标题`<br>`副标题` |
```

End normal Phase 1 with:

```text
你确认或改完这些封面文字、张数和画面方向后，我再开始生成。
```

Do not ask for confirmation when the runtime context explicitly says `noSecondConfirmation: true`, `backgroundExecution: true`, or `mustNotAskForConfirmation: true`. In that case, do the same planning internally, self-critique, then generate.

## Generation Contract

For one cover, call `image.generate` with a single `compiledPrompt` or `prompt`.

For multiple distinct cover variants, call `image.generate` once with `imagePlanItems`; each item must have its own `compiledPrompt`.

Payload requirements:

- `prompt`: overall cover brief or the single final prompt.
- `compiledPrompt`: required for a single cover when the prompt is already final.
- `count`: number of covers or variants.
- `aspectRatio`: required. Use the routed platform ratio.
- `quality`: use current app default unless the user asks for high quality.
- `referenceImages`: include only relevant references.
- `planConfirmed`: true after user confirmation, or when explicit runtime context allows no second confirmation.
- `imagePlanItems`: use for variant sets; `title` is internal only.

Never put planning labels, image numbers, role names, table headers, or hidden reasoning in visible text.

## Post-Generation QA

Check:

- confirmed text only; no extra text or pseudo text
- headline readable at mobile feed size
- cover has a strong first-glance hook
- subject identity preserved when references require it
- product/person absence is intentional, not accidental
- image does not look like a generic stock poster or marketplace product card unless requested

Output a compact QA table:

```markdown
| 图 | QA | 建议 |
|---|---|---|
| 1 | 通过 / 需复核：... | 保留 / 建议重跑 |
```

Then ask which image numbers to rerun, if any.
