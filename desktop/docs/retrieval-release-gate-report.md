---
doc_type: report
execution_status: completed
last_updated: 2026-04-23
owner: ai-agent
scope:
  - desktop/src-tauri/src/knowledge_index/evaluation.rs
  - desktop/src-tauri/src/knowledge_index/hybrid.rs
---

# Retrieval Release Gate Report

Status: Current

## Gate Model

Stage 7 turns retrieval quality into a hard release gate through deterministic fixture tests. The gate now checks:

- `Recall@20 >= 0.90`
- `citation span exactness >= 0.98`
- `unsupported claim rate <= 0.03`
- `multilingual NDCG@10 >= 0.80`
- `quote drift rate <= 0.01`

The implementation lives in:

- [evaluation.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/knowledge_index/evaluation.rs)

## Current Fixture Result

Current fixture metrics:

- Recall@20: `1.000`
- Multilingual NDCG@10: `0.800`
- Citation span exactness: `1.000`
- Unsupported claim rate: `0.000`
- Quote drift rate: `0.000`

Gate status:

- `PASS`

## How To Run

Use these commands as the release gate baseline:

```bash
cd desktop/src-tauri
cargo test release_gate_fixture_meets_thresholds -- --nocapture
cargo test grounding_audit_detects_unsupported_claims -- --nocapture
```

## Release Checklist

- Hybrid retrieval regression test passes.
- Grounding audit gate passes.
- OCR confidence penalty regression still passes.
- Anchor stability regression still passes.
- Execution plan remains at `stage8_completed`.

## Notes

- This gate is deterministic and fixture-based by design, so it can run on every version change.
- The current gate is a repository-local acceptance baseline, not yet a large external legal benchmark corpus.
- Stage 8 migration coverage now includes explicit decisions for `schema_only`, `fts_rebuild`, `block_anchor_rebuild`, `canonical_reparse`, and `full_rebuild`; manual full reparse paths require explicit OCR confirmation.
