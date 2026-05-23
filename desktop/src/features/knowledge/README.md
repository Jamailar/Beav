# `src/features/knowledge/`

Renderer-side knowledge feature helpers.

## Boundaries

- `knowledgeModel.ts` owns Knowledge page types and pure projections: catalog summary conversion, backend kind mapping, card kind resolution, visual-file detection, tag/search helpers, image ordering, and content hash.
- `pages/Knowledge.tsx` owns UI composition, dialogs, selection state, event subscriptions, and bridge calls.

## Rules

- Keep this folder side-effect free unless a future hook file explicitly documents its IPC/event ownership.
- Do not change backend kind strings here without keeping `knowledge:list-page`, `knowledge:get-item-detail`, and `knowledge:delete-batch` compatible.
