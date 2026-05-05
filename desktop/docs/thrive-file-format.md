---
doc_type: plan
execution_status: in_progress
last_updated: 2026-05-04
---

# Thrive File Format

`.thrive` is RedConvert's single-file authoring container. It is a ZIP archive with a required `manifest.json` at the archive root. The desktop app decides the content type from `manifest.json`, not from the file extension.

This first implementation enables the new `post` package shape. Other content kinds can use the same container later, but they should add their own required files only when their runtime is migrated.

## Container

Every `.thrive` file is a ZIP archive:

```text
example.thrive
  manifest.json
  content.md
  bindings.json
  variants/
    xiaohongshu.md
    reddit.md
    x.md
```

Rules:

- Archive paths must be relative.
- Archive paths must use `/`.
- Archive paths must not contain `..`.
- App code must not trust archive entries that escape the package root.
- Saves should write a temporary archive first, then replace the target file.

## `manifest.json`

`manifest.json` is the package identity and routing layer.

```json
{
  "id": "thrive-post-...",
  "type": "thrive-package",
  "schemaVersion": 1,
  "kind": "post",
  "packageKind": "post",
  "draftType": "richpost",
  "title": "Untitled",
  "status": "writing",
  "createdAt": 1777910400000,
  "updatedAt": 1777910400000,
  "entry": "content.md"
}
```

Fields:

- `schemaVersion`: package schema version.
- `kind`: product content kind. For this version, `post`.
- `packageKind`: legacy bridge field for existing runtime code. For post packages, `post`.
- `draftType`: legacy renderer field. For post packages, `richpost` until the UI naming is migrated.
- `entry`: main editable Markdown entry. For post packages, `content.md`.

## `content.md`

`content.md` is the platform-neutral post body. It is the default source for any target platform that does not have a platform-specific variant.

The app should preserve Markdown as the truth layer. Platform formatting, length checks, hashtag suggestions, and publishing constraints belong to platform profiles, not to this file.

## `bindings.json`

`bindings.json` stores references from the post to media, target platforms, published platform posts, source material, and inspirations.

```json
{
  "media": [],
  "targets": [],
  "publishedPosts": [],
  "sources": [],
  "inspirations": []
}
```

Media should reference the media library by id by default:

```json
{
  "media": [
    {
      "id": "media_001",
      "role": "gallery",
      "order": 0,
      "source": "media-library"
    }
  ]
}
```

Platform targets point to optional variants:

```json
{
  "targets": [
    {
      "platform": "xiaohongshu",
      "variantPath": "variants/xiaohongshu.md",
      "status": "draft"
    }
  ]
}
```

Published posts bind local targets to real platform records:

```json
{
  "publishedPosts": [
    {
      "platform": "xiaohongshu",
      "targetId": "target_xhs_001",
      "externalPostId": "abc123",
      "url": "https://example.com/post/abc123",
      "status": "published",
      "publishedAt": "2026-05-04T10:00:00+08:00"
    }
  ]
}
```

## `variants/`

`variants/` is optional. Each file is a platform-specific Markdown version derived from `content.md`.

Rules:

- If a target has no variant, publish or export from `content.md`.
- If a target has a `variantPath`, publish or export from that file.
- AI platform tuning should edit the target variant, not overwrite `content.md`.
- Merging a platform version back into `content.md` must be an explicit user action.

## Post Compatibility

The post format is intentionally small:

- Core content is Markdown.
- Media is a binding, not a copied asset by default.
- Platform rules live outside the package as profiles.
- Platform-specific edits are stored as optional Markdown variants.
- Published platform posts are bindings, not separate local file types.

This keeps the same `.thrive` post usable for Xiaohongshu, Reddit, X, Threads, LinkedIn, WeChat Channels, and future post-like platforms without changing the package structure.

## Current App Commands

The first post implementation supports these host commands:

- `manuscripts:read`: reads `content.md` from a `.thrive` post.
- `manuscripts:save`: writes `content.md` and preserves existing bindings and variants.
- `manuscripts:get-package-state`: returns manifest and bindings for the post.
- `manuscripts:get-post-bindings`: reads `bindings.json`.
- `manuscripts:update-post-bindings`: replaces `bindings.json`.
- `manuscripts:read-post-variant`: reads `variants/<platform>.md`.
- `manuscripts:save-post-variant`: writes `variants/<platform>.md` and upserts the matching target in `bindings.targets`.
- `media:bind`: for `.thrive` posts, writes media references into `bindings.media`.
