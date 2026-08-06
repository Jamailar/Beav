---
doc_type: architecture
execution_status: implemented_pending_runtime_acceptance
last_updated: 2026-08-06
---

# Generic web capture architecture

## Scope boundary

This path improves only generic `save-page-link` captures. Platform actions for
小红书、抖音、YouTube、知乎、B 站 and other social sites retain their existing
extractors. Selection, link, image, video, side panel, browser MCP, and Desktop
bridge contracts are not part of this path.

WeChat (`mp.weixin.qq.com`) always retains its previous MAIN-world capture
function, including its rich HTML shell and image-localization behavior.

## Runtime flow

```mermaid
flowchart LR
  A[Existing page-save command] --> B{Special platform action?}
  B -->|yes| C[Existing platform extractor]
  B -->|generic| D{WeChat?}
  D -->|yes| E[Existing MAIN-world extractor]
  D -->|no| F[On-demand Defuddle content script]
  F --> G{Quality accepted?}
  G -->|yes| H[CaptureDocument V1]
  G -->|no or error| E
  H --> I[Existing Knowledge payload mapper]
  E --> I
  I --> J[Existing Desktop Knowledge endpoint]
```

The content script is injected only when the user asks to save a generic page.
It receives a detached DOM clone, sanitizes extracted HTML with DOMPurify, and
does not observe, patch, or render the page.

## Compatibility rules

- `CaptureDocument V1` is internal to the extension. It is mapped back to the
  existing page-entry payload before calling the unchanged Knowledge endpoint.
- Source URL and `page-${hash(sourceUrl)}` external ID remain unchanged. No
  migration, new entity, or changed Desktop dedupe rule is introduced.
- A 5-second tab-and-URL cache prevents repeated click work. It is invalidated
  on navigation and tab removal.
- A blocked, sparse, timed-out, or failed Defuddle result never replaces the
  legacy result. It is observable in extension logs as `generic-capture-fallback`.

## Tests and maintenance

`pnpm test:generic-capture` exercises legacy payload equivalence, URL safety,
challenge/sparse-page fallback, a representative Defuddle fixture, cache rules,
and CaptureDocument conversion. `pnpm verify` asserts the new bundle exists and
the built extension still contains explicit legacy and WeChat protection.

The dependencies are intentionally narrow: `defuddle` extracts generic article
content, `dompurify` sanitizes retained HTML, and development-only `linkedom`
provides DOM fixtures. The internal Markdown field remains optional: the current
Knowledge endpoint consumes `text` and `html`, so the extension intentionally
does not load Defuddle's roughly 600 KiB Markdown renderer. Do not add template
DSLs, reader-mode UI, storage models, or browser-control protocol changes to
this subsystem.

Runtime note: the current source build is registered as an unpacked Chrome
extension, but the Desktop Bridge was not listening during the 2026-08-06
acceptance attempt and Chrome policy blocked automated access to
`chrome://extensions`. Reload the unpacked extension and complete a real
Knowledge read-back before release.
