---
doc_type: plan
execution_status: completed
last_updated: 2026-05-22
---

# Brand Workspace SQLite And AI Index

## Boundary

Only brand, product, and SKU assets use this workspace. Other asset library types remain in the existing subject catalog.

SQLite is the canonical source for brand/product/SKU relationships. Generated Markdown files under `assets/brand-workspace/ai-index/` are read-only projections for AI retrieval. Code and agents must not treat those projection files as writable source data.

## Storage

Canonical database:

- `assets/brand-workspace/brand-workspace.sqlite`

AI-readable projection:

- `assets/brand-workspace/ai-index/brands.index.md`
- `assets/brand-workspace/ai-index/brand_{brandId}.md`

The projection includes `generated: true`, `readOnly: true`, and `canonicalSource: "brand-workspace.sqlite"` so an agent can quickly understand that writes must go through tools or IPC.

## Schema

`brand_records` stores one row per brand. The first phase keeps only user-entered basics: name, description, and timestamps.

`product_records` stores one row per product. Each product has exactly one `brand_id`, enforced by the product row and foreign key. The first phase keeps name, description, and timestamps.

`product_skus` stores product variants. Each SKU belongs to one product and keeps a user-entered `variant_text`, such as `颜色：樱桃红；容量：3.5g`.

`asset_refs` stores file references for brands, products, and SKUs without mixing file paths into free-text descriptions.

## UI Contract

The brand category view is not a card grid. It renders a collapsible list:

- One brand per row.
- Expanding a brand shows its products.
- The product create action is scoped to the brand row, so the UI never asks the user to manually type a brand binding.
- Product editing uses a dedicated product/SKU modal, separate from the generic asset modal.

## AI Contract

AI reads from the generated Markdown projection because natural language is easier to inspect and summarize. The projection only contains user-entered brand, product, and SKU data in the first phase. AI writes must use structured operations:

- `brand-workspace:brand:upsert`
- `brand-workspace:product:upsert`
- `brand-workspace:sku:upsert`
- `brand-workspace:rebuild-ai-index`

After every mutation, the projection is rebuilt from SQLite. If the projection and SQLite disagree, SQLite wins.

## Migration Behavior

Existing subject catalog brands and products are synced into SQLite when the brand workspace is opened. This keeps old data visible while moving new brand/product/SKU edits onto the SQLite-backed workspace.

The sync is additive and conservative. It does not delete SQLite rows just because an old subject row is absent, which avoids losing products created directly in the brand workspace.
