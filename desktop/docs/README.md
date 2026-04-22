# Documentation Map

本目录承载跨模块、跨技术栈的开发文档。模块级说明优先放在代码目录旁边，本目录只放“需要跨目录阅读”的内容。

## How To Use

1. 先看本页找到入口。
2. 再跳转到对应代码目录的 README。
3. 改动完成后，回写这里列出的契约或流程文档。

## Current Core Docs

### Architecture

- [architecture/system-overview.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/architecture/system-overview.md)
- [architecture/product-module-breakdown.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/architecture/product-module-breakdown.md)
- [legal-grade-retrieval-architecture-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/legal-grade-retrieval-architecture-plan.md)
- [legal-grade-retrieval-execution-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/legal-grade-retrieval-execution-plan.md)
- [aionrs-comparison-optimization-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/aionrs-comparison-optimization-plan.md)
- [migration-architecture.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/migration-architecture.md)
- [ai-runtime-maintenance-overview.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/ai-runtime-maintenance-overview.md)
- [agent-collaboration-upgrade-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/agent-collaboration-upgrade-plan.md)
- [skill-runtime-v2.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/skill-runtime-v2.md)

### Development

- [development/setup.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/development/setup.md)
- [development/frontend-dev.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/development/frontend-dev.md)
- [development/tauri-host-dev.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/development/tauri-host-dev.md)
- [development/testing-and-verification.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/development/testing-and-verification.md)
- [development/debugging-runbook.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/development/debugging-runbook.md)
- [development/release-and-versioning.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/development/release-and-versioning.md)

### Contracts

- [contracts/shared-types.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/contracts/shared-types.md)
- [contracts/runtime-events.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/contracts/runtime-events.md)
- [contracts/workspace-schema.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/contracts/workspace-schema.md)
- [ipc-inventory.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/ipc-inventory.md)

### Feature References

- [video-editor-transformation-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/video-editor-transformation-plan.md)
- [video-editor-parity-checklist.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/video-editor-parity-checklist.md)
- [manuscript-package-html-architecture.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/manuscript-package-html-architecture.md)
- [runtime-context-bundle.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/runtime-context-bundle.md)
- [runtime-memory-recall.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/runtime-memory-recall.md)
- [runtime-child-runtime-v2.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/runtime-child-runtime-v2.md)
- [runtime-script-execution-v1.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/runtime-script-execution-v1.md)
- [runtime-agent-job-v1.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/runtime-agent-job-v1.md)
- [runtime-capability-guardrails.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/runtime-capability-guardrails.md)

## Doc Conventions

- 规范见 [doc-style.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/doc-style.md)。
- 每篇“当前有效”的文档应写清楚：
  - 适用范围
  - 入口代码
  - 数据流或调用流
  - 变更触发条件
  - 验证方式
- 方案、迁移、调研文档应标记为 `Current`、`Reference`、`Legacy` 或 `Superseded`。

## Recommended Reading By Task

- 改页面：先看 `src/README.md`、对应 `src/pages/README.md`、再看 [development/frontend-dev.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/development/frontend-dev.md)
- 改 IPC：先看 `src/bridge/README.md`、`src-tauri/src/commands/README.md`、再看 [development/tauri-host-dev.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/development/tauri-host-dev.md)
- 改 runtime：先看 `src/runtime/README.md`、`src-tauri/src/runtime/README.md`、`src-tauri/src/events/README.md`
- 改视频编辑：先看 `src/features/video-editor/README.md`、`src/components/manuscripts/README.md`、`src/remotion/README.md`
- 改技能/提示词/MCP：先看 `prompts/README.md`、`prompts/library/README.md`、`src-tauri/src/skills/README.md`、`src-tauri/src/mcp/README.md`
