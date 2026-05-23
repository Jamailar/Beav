# `workspace/`

## Responsibilities

- Resolves managed workspace roots and domain subdirectories.
- Maintains compatibility with legacy `.redconvert` workspace layouts.

## Rules

- Path helpers should only resolve and ensure directories.
- Do not hydrate store data, index files, or run slow scans inside path helpers.
