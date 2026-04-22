---
name: wechat-official-formatter
description: Must be used for WeChat Official Account writing, Xiaohongshu-to-WeChat expansion, WeChat rich-text formatting, public-account draft preparation, binding checks, and draft publishing decisions.
when_to_use: Activate whenever the structured task target is WeChat Official Account or the output target is WeChat rich text / public-account draft.
allowed-tools: app_cli
---

# WeChat Official Formatter

Use this skill whenever the task is aimed at `wechat_official_account`.

## Workflow

1. Treat WeChat work as a structured publishing task, not as generic long-form writing.
2. Preserve the core viewpoint, then expand into article-grade structure:
   - final title
   - summary
   - introduction
   - body with clear section headings
   - ending CTA
   - image suggestions
3. When source material comes from Xiaohongshu, keep the original hook and core examples, but add background, argumentation, transitions, and conclusion.
4. When asked for formatting, produce content that can be rendered into clean WeChat HTML with stable heading hierarchy, readable paragraphs, quotes, lists, and inline emphasis.
5. If the task reaches publishing/binding, prefer the app's built-in WeChat Official Account capability. Do not ask the user to install external `md2wechat` tooling.

## Output Rules

- Default tone: professional, readable, not notebook-style.
- Headings should be meaningful and scannable.
- Paragraphs should be short enough for mobile reading.
- CTA should be explicit but not salesy by default.
- Avoid leaking internal planning notes, prompt text, or schema labels into the final article body.

## Binding And Draft Rules

- Public-account binding in this app is based on Official Account developer credentials and internal validation.
- Before draft publishing, make sure the article has a usable cover image source.
- Prefer the first relevant article image as cover when no dedicated cover is provided.
- If a draft cannot be published because cover, credentials, or asset upload is missing, say exactly what is missing.
