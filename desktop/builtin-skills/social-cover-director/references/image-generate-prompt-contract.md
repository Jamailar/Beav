# Image Generate Prompt Contract

Use this before writing final prompts for `Operate(resource="image", operation="generate", input={ ... })`.

## Prompt Structure

Write final prompts in Chinese by default. English visual terms are acceptable only when they improve model stability. Keep exact on-image copy in the target language.

Template:

```text
Create one platform-native social media cover image.

Platform and surface: {platform}, {surface}.
Market and language: {market}, on-image text in {language}.
Aspect ratio: {aspectRatio}.
Cover role: {primary_cover | variant_a | variant_b | short_video_frame | pin_cover}.

Content promise:
Target reader: {reader}.
Core tension or curiosity: {tension}.
Click promise: {what the viewer expects to get after clicking}.

Reference image roles:
{Reference 1: subject_identity/style_reference/base_image/content_context.}
{Reference 2: ...}
If a reference is subject_identity, preserve identity, shape, face/product/place details, colors, and recognizable design.
If a reference is style_reference, learn composition, typography, color, and mood without copying text.
If a reference is base_image, keep the core subject and spatial relation while turning it into a cover.

Creative direction:
Style pack: {style_pack}.
Main attention mechanic: {attention_mechanic}.
Secondary attention mechanic: {secondary_or_none}.
Scene/composition: {scene, camera angle, crop, layout, foreground/background relationship}.
Lighting: {lighting}.
Color: {palette, saturation, contrast}.
Texture/finish: {material, grain, gloss, flash, softness}.

Typography and copy:
Use only this exact on-image copy:
{confirmed_copy_with_line_breaks}
Typography hierarchy: {headline/subline/label rules}.
Placement: {safe area and relationship to subject}.
No additional text, pseudo text, random labels, interface elements, watermarks, AI labels, or unreadable filler.

Quality bar:
The image must be bold, scroll-stopping, social-native, and readable at mobile feed size.
Do not make it look like a generic stock poster, planning table, UI mockup, or marketplace product card unless explicitly requested.
```

## Payload Shape

Single cover:

```json
{
  "prompt": "final prompt",
  "compiledPrompt": "same final prompt",
  "count": 1,
  "aspectRatio": "3:4",
  "quality": "high",
  "planConfirmed": true,
  "referenceImages": []
}
```

Cover variants:

```json
{
  "prompt": "overall variant brief",
  "count": 3,
  "aspectRatio": "3:4",
  "quality": "high",
  "planConfirmed": true,
  "referenceImages": [],
  "imagePlanItems": [
    {
      "title": "primary-cover",
      "copy": "主标题\\n副标题",
      "compiledPrompt": "final prompt for variant 1"
    }
  ]
}
```

`title` is internal metadata only. Never ask the model to render it.

## Aspect Ratio Guide

| Surface | Preferred aspect ratio |
|---|---|
| 小红书图文 | `3:4` or `4:5` |
| 抖音 / TikTok / Reels / Shorts / Stories | `9:16` |
| Instagram feed | `4:5` |
| Facebook/Meta feed | `4:5` or `1:1` |
| Pinterest standard pin | `2:3` |
| YouTube thumbnail-like cover | `16:9` |
| WeChat moments grid | `1:1` or `4:5` |
| 公众号文章封面 | `16:9` or `4:3` |

## Prompt Quality Checklist

- The prompt says the platform and surface.
- Aspect ratio is explicit.
- The content promise is visible and specific.
- There is one strong attention mechanic.
- Exact copy is included with line breaks.
- The prompt forbids extra generated text.
- Reference image roles are explicit.
- Subject identity is preserved when needed.
- The cover is not a full carousel card or ecommerce detail image.
