---
doc_type: report
execution_status: completed
last_updated: 2026-04-23
owner: ai-agent
scope:
  - desktop/src-tauri/src/knowledge_index/hybrid.rs
  - desktop/src-tauri/src/knowledge_index/document_blocks.rs
  - desktop/src-tauri/src/tools/knowledge_search.rs
---

# Stage 6 Hybrid Retrieval Evaluation Report

Status: Current

## Summary

Stage 6 introduces a configurable hybrid retrieval lane on top of the existing lexical foundation:

- sparse bilingual legal term expansion
- local dense semantic lane
- Weighted RRF fusion
- legal-aware, citation-aware, confidence-aware rerank

The lane is optional. `knowledge.search` defaults to `retrievalMode=hybrid`, and callers can force `retrievalMode=lexical` to fall back to the pre-Stage-6 behavior.

## Evaluation Method

Current verification uses a deterministic offline fixture embedded in:

- [hybrid.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/knowledge_index/hybrid.rs)

Fixture corpus:

1. Chinese law text containing `合同 / 违约 / 救济`
2. English commentary containing `contract / breach / remedies`
3. Chinese labor law text containing `解除劳动合同 / 赔偿`
4. English case note on employment termination

Fixture queries:

1. `contract breach remedy`
2. `termination compensation labor contract`

Metric:

- Mean Reciprocal Rank on the top ranked result

## Result

Observed from the test run:

- lexical MRR: `0.000`
- hybrid MRR: `0.750`

Interpretation:

- lexical-only retrieval misses the cross-language target in this fixture set
- hybrid retrieval recovers the intended legal text through sparse bilingual expansion and semantic fusion
- rerank then keeps statute-style text ahead of commentary/case-note text

## What Changed Technically

- `knowledge_document_blocks` now stores `semantic_vector_json`
- query planning expands legal bilingual terms before sparse recall
- semantic lane scores precomputed local vectors
- fusion uses Weighted RRF
- final rerank adds:
  - legal authority/effectiveness score
  - citation/readability bonus
  - OCR confidence penalty

## Current Limits

- dense vectors are still local deterministic embeddings, not provider-grade production embeddings
- offline evaluation is currently fixture-based, not a full legal benchmark corpus
- sparse expansion is rule-based and should later be replaced or augmented by learned sparse retrieval

## Release Readiness For Stage 6

This stage is sufficient to make hybrid retrieval a real, switchable enhancement rather than a hard dependency. It is not yet the final legal-product benchmark gate; that belongs to Stage 7.
