# `src-tauri/src/document_ingest/`

本目录承载文档源接入层，负责把外部文件或目录注册成可被知识检索索引消费的 document source。

## Main Files

- `registry.rs`: 文档源 ingest request、copied-file / tracked-folder / obsidian-vault 注册逻辑

## Rules

- ingest 层只负责路径规范化、workspace 托管复制、文档源注册和入口校验，不直接承担检索逻辑。
- 新增 document source kind 时，优先扩 `registry.rs` 的 typed request 和分支处理，不要把接入逻辑继续堆回 `knowledge.rs`。
- `copied-file` 必须显式复制进 workspace 托管目录，避免索引引用临时路径。
- `tracked-folder` / `obsidian-vault` 只注册已有目录，不复制内容，并保留 requested options 回执。

## Verification

- 验证 copied-file 会把文件复制进 workspace docs/imported 并创建 document source
- 验证 tracked-folder / obsidian-vault 会注册已有目录并返回 source payload
- 验证 batch-ingest / HTTP / IPC 路径继续复用同一 ingest contract
