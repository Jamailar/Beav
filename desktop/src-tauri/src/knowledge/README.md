# `knowledge/`

Internal helpers for the `knowledge.rs` module.

## Files

- `source_normalizers.rs`: converts source-specific payloads into the shared `KnowledgeEntryIngestRequest` contract, including note kind normalization, note title/author derivation, Zhihu answer/article mapping, source seed resolution, and content text normalization.

## Rules

- Source adapters should emit the shared ingest contract; persistence and projection refresh stay in `knowledge.rs`.
- Keep old `/api/knowledge/entries`, V2 XHS, Zhihu, document source, and media asset routes compatible.
- Do not write workspace files from source normalizers.
