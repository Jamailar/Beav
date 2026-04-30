# RedConvert Desktop 迁移差异分析报告

> 生成日期: 2026-04-30
> 对比范围: `desktop/` (Tauri v1.11.0) vs `archive/desktop-electron/` (Electron v1.9.0)

---

## 一、概览

| 维度 | 旧版 (Electron) | 新版 (Tauri) | 差异程度 |
|------|----------------|-------------|---------|
| 前端文件总数 | 678 | 676 | 小 |
| 前端新增文件 | — | 3 | — |
| 前端移除文件 | 5 | — | — |
| 前端内容差异文件 | — | — | 35个 |
| 后端语言 | TypeScript (Node.js) | Rust | 完全重写 |
| 后端核心模块数 | ~205 (.ts) | 314 (.rs) | — |
| 构建系统 | electron-builder + vite | tauri + vite | 完全不同 |
| 运行时依赖 | ~100 npm包 | ~56 npm包 + 47 Rust crates | 大 |

**总体评估**: 前端约 **94%** 文件保持相同（638/678），前端差异集中在新增功能和 UI 增强。后端从 TypeScript 完全重写为 Rust，架构从单体大文件变为高度模块化。

---

## 二、前端差异 (src/)

### 2.1 仅在 desktop/ 中的新文件 (3个)

| 文件 | 行数 | 功能说明 |
|------|------|---------|
| `src/utils/mediaReferencePreflight.ts` | 347 | 附件和内联数据预处理工具 |
| `src/pages/redclaw/RedClawFilePreviewPane.tsx` | 274 | RedClaw 文件预览面板 |
| `src/pages/workboard/CollaborationBoard.tsx` | 956 | 全新协作看板组件 |

### 2.2 仅在 archive/ 中的旧文件 (5个)

| 文件 | 说明 | 去向 |
|------|------|------|
| `src/compat/electronTransport.ts` | Electron IPC 传输层 | 不再需要 (Tauri 原生 IPC) |
| `src/compat/tauri-core.ts` | Tauri API 兼容 shim | 不再需要 (原生 Tauri) |
| `src/compat/tauri-event.ts` | Tauri 事件兼容 shim | 不再需要 (原生 Tauri) |
| `src/components/KnowledgeChatModal.tsx` | 知识库对话弹窗 | 功能合并到主 Chat 组件 |
| `src/components/manuscripts/WritingDiffProposalPanel.tsx` | 写作差异提案面板 | 合并到 WritingDraftWorkbench |

### 2.3 有内容差异的共享文件 (35个)

#### 差异大 (≥1000 diff lines) — 架构级变更

| 文件 | diff行数 | 变更要点 |
|------|---------|---------|
| `src/pages/settings/SettingsSections.tsx` | 1703 | 新增视觉索引配置(OCR/文档解析/rerank)、FileIndexDashboard |
| `src/pages/Knowledge.tsx` | 1080 | 新增作者元数据字段、移除独立KnowledgeChatModal |
| `src/pages/Chat.tsx` | 1069 | 新增@成员提及和#知识库提及支持 |

#### 差异中 (50-999 diff lines) — 功能增强

| 文件 | diff行数 | 变更要点 |
|------|---------|---------|
| `src/pages/Settings.tsx` | 857 | 新增"实验性"设置标签页、视觉索引、设置深度链接 |
| `src/components/ChatComposer.tsx` | 708 | 新增成员/知识库提及接口、内联附件支持 |
| `src/components/MessageItem.tsx` | 665 | 新增协议块过滤、成员Actor/链接目标类型 |
| `src/components/ProcessTimeline.tsx` | 551 | 完全重构，新增错误类型、导航事件链接 |
| `src/pages/RedClaw.tsx` | 486 | 集成FilePreviewPane、媒体任务订阅、动态快捷方式 |
| `src/pages/Workboard.tsx` | 454 | 集成CollaborationBoard、任务编辑器UI |
| `src/pages/Advisors.tsx` | 430 | 新增成员技能跟踪、技能版本管理 |
| `src/pages/Wander.tsx` | 421 | 知识库目录集成、替换定位策略 |
| `src/bridge/ipcRenderer.ts` | 295 | 新增 fallback 响应构建器、内联附件处理、文件索引dashboard IPC |
| `src/pages/GenerationStudio.tsx` | 242 | AI源配置、模型能力过滤 |
| `src/types.d.ts` | 224 | 新增6个协作事件类型、Collab* 接口定义 |
| `src/pages/Manuscripts.tsx` | 215 | 包草稿路径检测、内联标题编辑、reviewBody状态 |
| `src/components/manuscripts/CodeMirrorEditor.tsx` | 164 | 内联合并/差异视图支持 |
| `src/components/manuscripts/WritingDraftWorkbench.tsx` | 140 | 移除DiffProposalPanel、工具约束、AI上下文限制 |
| `src/index.css` | 123 | user-select规则重构、编辑器CSS打磨 |
| `src/runtime/runtimeEventStream.ts` | 106 | 新增6个协作事件处理器 |
| `src/pages/redclaw/config.ts` | 101 | 静态快捷方式→场景感知快捷方式系统 |
| `src/App.tsx` | 100 | 设置深度链接、知识引用、deliveryMode |
| `src/pages/Archives.tsx` | 85 | 关联账户摘要展示 |
| `src/pages/settings/shared.tsx` | 65 | OAuth子配置、工具超时设置 |
| `src/pages/CoverStudio.tsx` | 65 | 多空间支持 |
| `src/pages/redclaw/RedClawOnboardingFlow.tsx` | 64 | useRef防重入优化 |

#### 差异小 (<50 diff lines) — 微调

| 文件 | diff行数 | 变更要点 |
|------|---------|---------|
| `src/features/chat/editorSessionBinding.ts` | 45 | 写作草稿类型检测、工具白名单 |
| `src/config/startupAnnouncements.ts` | 23 | 新增v1.10.3公告 |
| `src/pages/redclaw/RedClawOnboardingFlowHost.tsx` | 19 | useMemo优化 |
| `src/notifications/policy.ts` | 18 | 余额不足/登录失效检测 |
| `src/components/Layout.tsx` | 16 | 自动更新检查定时器 |
| `src/utils/redclawAuthoring.ts` | 8 | 新增memory工具动作 |
| `src/notifications/types.ts` | 8 | navigate payload扩展 |
| `src/pages/settings/README.md` | 5 | 文档更新 |
| `src/pages/CreativeChat.tsx` | 4 | 占位文本国际化 |
| `src/config/aiSources.ts` | 4 | Anthropic URL修正 |

### 2.4 完全相同的目录 (无差异)

`hooks/`, `features/audio-input/`, `features/media-jobs/`, `features/video-editor/`, `features/official/`, `ipc/`, `logging/`, `remotion/`, `types/`, `components/wander/`, `vendor/freecut/` (500+文件), `components/manuscripts/remotion/`, `timeline/`, `texts/`, `subtitles/`, `transitions/`

### 2.5 前端关键架构变更总结

1. **协作系统**: 6种新 runtime 事件类型、CollabSession/Member/Task/Report/Message 数据结构、CollaborationBoard 组件
2. **提及系统**: `@成员` 和 `#知识库` 提示、ChatMemberMentionOption / ChatKnowledgeMentionOption 接口
3. **设置深度链接**: 从错误信息直接跳转到特定设置标签页（如余额不足→AI登录配置）
4. **视觉索引**: 完整的 OCR、文档解析 (docling/tika/unstructured)、Rerank 配置管线
5. **任务编辑器**: Workboard 上的完整任务创建/编辑 UI
6. **写作编辑器增强**: 工具白名单约束、AI 上下文限制、内联差异视图

---

## 三、后端差异 (electron/ vs src-tauri/src/)

### 3.1 架构变更总览

| 特性 | Electron (Node.js) | Tauri (Rust) | 变化 |
|------|-------------------|-------------|------|
| 搜索 | IndexManager + VectorStore | Tantivy 全文检索引擎 | 重大升级 |
| CLI执行 | bashTool.ts (基础) | cli_runtime/ (沙箱+PTY+多语言安装器) | 完全重构 |
| 子代理 | subagentRuntime.ts | subagents/ (任务板+邮箱+唤醒) | 架构升级 |
| 任务调度 | background*.ts | scheduler/ (死信队列+租约+心跳) | 更健壮 |
| MCP | mcpRuntime.ts + mcpStore.ts | mcp/ (工具清单+团队MCP+资源管理) | 更全面 |
| Prompt系统 | 外部.txt文件动态加载 | Rust源码嵌入+技能系统 | 范式变更 |
| 日志 | debugLogger.ts | logging/ (结构化+文件/内存sink+移除) | 重大升级 |
| LLM传输 | 内嵌HTTP调用 | provider_compat/ + llm_transport/ + provider_runtime/ | 更结构化 |

### 3.2 新增 Rust 模块 (Electron 无对应)

| 模块 | 功能 | 优先级 |
|------|------|--------|
| `profile_learning/` | 用户写作风格/profile学习 | 🔴 新核心功能 |
| `document_parse/` | PDF/法律元数据/视觉LLM解析 | 🔴 新核心功能 |
| `knowledge_index/` | Tantivy全文索引+混合搜索 | 🔴 搜索架构升级 |
| `document_ingest/` | 文档摄取管线 | 🟡 辅助功能 |
| `media_runtime/` | 媒体生成运行时 | 🟡 辅助功能 |
| `startup_migration.rs` | Electron→Tauri数据迁移 | 🟢 一次性工具 |
| `legacy_import.rs` | 旧数据导入 | 🟢 一次性工具 |

### 3.3 可能缺失的功能 (Electron有, Rust无明确对应)

| 功能 | 风险 | 说明 |
|------|------|------|
| 向量嵌入服务 (EmbeddingService) | **高** | Tantivy可能不需要独立嵌入服务，但需确认 |
| YouTube抓取 (youtubeScraper) | **中** | 可能移至前端或工具 |
| 字幕队列 (subtitleQueue) | **中** | 未找到 Rust 对应 |
| LSP集成 (lsp/*) | **中** | 可能被移除 |
| 媒体库存储 (mediaLibraryStore) | **中** | 可能移至前端 |
| 封面/模板存储 (cover*Store) | **中** | 可能移至前端 |
| 计算器工具 (calculatorTool) | **低** | 可能被移除 |
| Todo工具 (todoTool) | **低** | 可能被移除 |
| Bing搜索 (bingSearch) | **低** | 被 web_access.rs 替代 |
| 无头代理/工作进程 | **低** | cli_runtime + agent/ 覆盖 |

### 3.4 Skills/Prompts 迁移状态

| 资源 | Electron 位置 | Tauri 处理方式 | 状态 |
|------|-------------|--------------|------|
| 40+ 运行时Prompt (.txt) | `electron/prompts/library/` | 嵌入 Rust 源码 (skills/prompt.rs等) | ✅ 已迁移 |
| 系统Skills | `electron/system-skills/` | `builtin-skills/` 目录 + skills/loader.rs | ✅ 已迁移 |
| 内置Skills (10个) | `electron/builtin-skills/` | `builtin-skills/` 目录 + file watcher | ✅ 已迁移 |
| WebSocket shim | `electron/shims/ws-interop-safe.mjs` | 不再需要 | ✅ N/A |

---

## 四、配置差异

### 4.1 package.json — 重大差异

| 项目 | 旧版 (Electron) | 新版 (Tauri) |
|------|----------------|-------------|
| 包名 | `red-convert-desktop` | `redbox` |
| 版本 | 1.9.0 | 1.11.0 |
| 运行时依赖 | ~100 (含 better-sqlite3, openai, ws, jsdom 等) | ~56 (移除所有 Node 后端依赖) |
| 开发依赖 | 18 (含 electron, electron-builder 等) | 11 (新增 @tauri-apps/cli) |
| 构建脚本 | `build:mac`/`:win`/`:nosign` (electron-builder) | `tauri:dev`/`tauri:build` (cargo + vite) |
| Node 版本要求 | `>=22 <23` | 无要求 (Rust 不依赖 Node) |
| electron-builder 配置 | 内嵌 48 行 (签名/公证/asar) | 移除 (由 tauri.conf.json 替代) |

### 4.2 vite.config.ts — 重大差异

- **旧版**: 171行，含 `vite-plugin-electron`、3个自定义复制插件、rollup vendor分块、ws互操作shim、tauri兼容路径别名
- **新版**: 23行，仅 `@vitejs/plugin-react`、Tauri环境变量前缀、端口固定1420
- **简化原因**: Tauri 独立处理 Rust 后端编译和资源打包

### 4.3 tsconfig.json — 中等差异

- 新版移除 `strict: true`、`noFallthroughCasesInSwitch`
- 新版使用更窄的 `include`/`exclude` 列表 (14个exclude条目)
- 新版移除 `@tauri-apps/api/*` 兼容路径别名 (不再需要)

### 4.4 其他配置 — 微小差异

- **tailwind.config.js**: 新增 `surface.tertiary` 颜色，其余一致
- **postcss.config.js**: 内容完全一致 (新版额外多一个 .cjs 副本)
- **index.html**: lang 变更 (`zh-CN`)、标题变更 (`RedBox`)

### 4.5 新版专属配置文件

| 文件 | 说明 |
|------|------|
| `src-tauri/Cargo.toml` | 47个 Rust crate 依赖 (rusqlite, tantivy, reqwest, tokio 等) |
| `src-tauri/tauri.conf.json` | 窗口配置 (1440×920)、资源权限、打包配置 |
| `src-tauri/capabilities/default.json` | Tauri 权限声明 |
| `scripts/tauri-preflight.mjs` | Tauri 构建前健康检查 |
| `scripts/sync-version.mjs` | package.json → Cargo.toml 版本同步 |
| `scripts/build-*-release.mjs` | 各平台发布构建脚本 |

---

## 五、测试/CI/SQLite Schema 迁移分析

### 5.1 测试覆盖

两版均未在 `src/` 或 `src-tauri/` 目录中配置自动化测试框架（无 vitest/jest 测试文件，无 `__tests__/` 目录）。`package.json` 中均无 `test` 脚本。

| 维度 | 旧版 (Electron) | 新版 (Tauri) | 评估 |
|------|----------------|-------------|------|
| 前端单元测试 | 无 | 无 | 均缺失 |
| 后端单元测试 | 无 | 无（Rust `#[cfg(test)]` 未发现） | 均缺失 |
| E2E 测试 | 无 | 无 | 均缺失 |
| CI 流水线 | 无 `.github/workflows` | 无 `.github/workflows` | 均缺失 |

> **建议**: 迁移完成后应优先补充核心路径的集成测试（Chat/Agent/Knowledge 流程），并建立 CI 流水线。

### 5.2 CI/CD 配置

两版均未在仓库中配置 GitHub Actions 或其他 CI 系统。构建脚本依赖本地执行：

| 构建场景 | 旧版 (Electron) | 新版 (Tauri) |
|---------|----------------|-------------|
| 开发构建 | `npm run dev` (vite + electron) | `npm run tauri:dev` (vite + cargo) |
| 生产构建 | `npm run build:mac` / `build:win` | `npm run tauri:build` |
| 签名/公证 | electron-builder 内嵌配置 | `tauri.conf.json` + 外部脚本 |
| 版本同步 | 手动 | `scripts/sync-version.mjs` 自动同步 |

### 5.3 SQLite Schema 迁移

| 维度 | 旧版 (Electron) | 新版 (Tauri) |
|------|----------------|-------------|
| 数据库引擎 | `better-sqlite3` (Node.js 原生绑定) | `rusqlite` (Rust 原生绑定) |
| Schema 定义 | TypeScript 运行时创建表 | Rust 编译时定义（`knowledge_index/schema.rs`、`persistence/mod.rs`） |
| 迁移机制 | 无显式迁移文件（隐式于 ORM/手动 SQL） | 显式迁移管线（`knowledge_index/migration.rs`、`startup_migration.rs`） |
| 数据兼容 | — | Electron→Tauri 数据迁移（`startup_migration.rs`、`legacy_import.rs`） |
| 知识库索引 Schema | VectorStore 内嵌 | Tantivy 全文索引 + 独立 `knowledge_index/schema.rs` |

**关键 Schema 差异**:
1. **知识库索引**: Electron 使用向量嵌入存储 → Tauri 使用 Tantivy 倒排索引 + BM25，schema 结构完全不同
2. **Agent 持久化**: Electron 隐式存储 → Tauri `agent/persistence.rs` 结构化序列化
3. **会话管理**: Electron `chatSessionManager.ts` → Tauri `commands/chat_state.rs` + `session_manager.rs`
4. **迁移路径**: `startup_migration.rs` 负责 Electron→Tauri 首次启动数据迁移，`legacy_import.rs` 负责旧格式导入

> **风险提示**: 用户升级时依赖 `startup_migration.rs` 的正确执行。若迁移失败，用户将丢失历史数据。建议在迁移前强制备份 SQLite 文件。

---

## 六、风险补充分析

### 6.1 平台兼容性风险

| 风险项 | 级别 | 说明 |
|-------|------|------|
| macOS 签名/公证 | **高** | Tauri 使用不同的签名流程，需验证开发者证书和公证兼容性 |
| Windows 构建 | **中** | Cargo 原生编译依赖 Visual Studio Build Tools，环境配置更复杂 |
| Linux 兼容性 | **中** | Tauri 依赖 `webkit2gtk`、`libgtk-3` 等系统库，不同发行版差异大 |
| ARM64 支持 | **低** | Tauri 原生支持 ARM，但 rusqlite/tantivy 等 crate 需验证 ARM 编译 |

### 6.2 性能回归风险

| 风险项 | 级别 | 说明 |
|-------|------|------|
| 首次启动时间 | **中** | Tantivy 索引初始化可能比 Electron VectorStore 慢 |
| 内存占用 | **低** | Rust 通常优于 Node.js，但 Tantivy 索引可能占用额外内存 |
| IPC 延迟 | **低** | Tauri IPC 基于 Rust 原生通道，理论上优于 Electron IPC |
| 大文件索引 | **中** | Tantivy 全文索引大文件时的性能需验证 |

### 6.3 数据库升级风险

| 风险项 | 级别 | 说明 |
|-------|------|------|
| Schema 不兼容 | **高** | Electron better-sqlite3 → Tauri rusqlite，表结构可能不兼容 |
| 迁移失败恢复 | **高** | 缺少迁移失败后的回滚机制 |
| 数据丢失 | **高** | 向量嵌入数据无法直接迁移到 Tantivy 全文索引 |
| WAL 模式兼容 | **低** | rusqlite 默认 WAL 模式，与 better-sqlite3 行为一致 |

### 6.4 供应链风险

| 风险项 | 级别 | 说明 |
|-------|------|------|
| Rust Crate 审计 | **中** | 47 个 Rust crate 依赖，需定期 `cargo audit` |
| npm 包减少 | ✅ 正面 | 运行时依赖从 ~100 降至 ~56，攻击面缩小 |
| 原生二进制 | **中** | Rust 编译产物为原生二进制，逆向工程风险低于 JS 混淆 |
| Tauri 版本锁定 | **低** | Cargo.lock 锁定依赖版本，且 Tauri 为正式发布版本 |

---

## 七、优先级模块清单

### 7.1 按差异程度和执行顺序排序

#### 🔴 P0 — 高优先级 (差异大, 需要立即关注)

| 模块 | diff行数 | 说明 | 建议执行顺序 |
|------|---------|------|------------|
| 设置/视觉索引 (Settings + FileIndexDashboard) | 1703 | 完整的OCR/文档解析/rerank配置管线 | 1 |
| 知识库 (Knowledge) | 1080 | 作者元数据、移除独立Modal | 2 |
| 聊天系统 (Chat + ChatComposer + MessageItem) | 1069+708+665 | @提及/#知识库提及、协议过滤 | 3 |
| 协作系统 (CollaborationBoard + runtime events + types) | 956+224+106 | 全新功能，CollaborationBoard + 6种事件类型 | 4 |
| IPC桥接 (bridge/ipcRenderer) | 295 | 内联附件fallback、文件索引dashboard | 5 |
| RedClaw (RedClaw + FilePreviewPane + config) | 486+274+101 | 场景感知快捷方式、文件预览 | 6 |

#### 🟡 P1 — 中优先级 (差异中, 功能增强)

| 模块 | diff行数 | 说明 | 建议执行顺序 |
|------|---------|------|------------|
| ProcessTimeline | 551 | 完全重构，新增错误类型、导航事件链接 | 7 |
| Workboard (Workboard + CollaborationBoard) | 454 | 任务编辑器UI、协作看板 | 8 |
| Advisors (成员技能跟踪) | 430 | 技能版本管理 | 9 |
| Wander (知识库目录集成) | 421 | 替换定位策略 | 10 |
| 生成工作室 (GenerationStudio) | 242 | AI源/模型过滤 | 11 |
| 手稿系统 (Manuscripts + CodeMirrorEditor + WritingDraft) | 215+164+140 | 差异视图、编辑器约束 | 12 |
| App入口 | 100 | 设置深度链接、知识引用、deliveryMode | 13 |

#### 🟢 P2 — 低优先级 (差异小, 微调)

| 模块 | diff行数 | 说明 | 建议执行顺序 |
|------|---------|------|------------|
| Archives (关联账户) | 85 | 关联账户摘要展示 | 14 |
| 设置子模块 (shared + README) | 65+5 | OAuth子配置、工具超时 | 15 |
| CoverStudio (多空间) | 65 | 多空间支持 | 16 |
| RedClaw Onboarding (防重入优化) | 64+19 | useRef防重入、useMemo优化 | 17 |
| 编辑器会话绑定 (工具白名单) | 45 | 写作草稿类型检测 | 18 |
| 启动公告 + AI源 | 23+4 | v1.10.3公告、Anthropic URL修正 | 19 |
| 通知 (policy + types) | 18+8 | 余额/登录检测、navigate扩展 | 20 |
| index.css + Layout + CreativeChat + redclawAuthoring | 123+16+4+8 | CSS打磨、自动更新、文本国际化 | 21 |

### 7.2 后端迁移优先级

| 模块 | 差异程度 | 风险 | 说明 |
|------|---------|------|------|
| 向量嵌入服务 (EmbeddingService) | 大 | 高 | 需确认Tantivy是否完全替代了嵌入服务 |
| YouTube抓取 | 大 | 中 | 需要决定是移至前端/工具还是重新实现 |
| 字幕队列 | 大 | 中 | 未找到对应，需确认是否被移除 |
| LSP集成 | 大 | 中 | 可能需重新实现或移除 |
| 媒体库/封面/模板存储 | 中 | 中 | 可能已移至前端，需验证功能完整性 |
| 无头代理/工作进程 | 中 | 低 | cli_runtime + agent/ 可能已覆盖 |

### 7.3 迁移覆盖度估算

| 层级 | 覆盖率 | 置信度 |
|------|--------|--------|
| 前端组件 (Components) | 95%+ | 高 |
| 前端页面 (Pages) | 95%+ (含增强) | 高 |
| 前端工具/Hooks (Utils/Hooks) | 98%+ | 高 |
| 后端核心服务 (Chat/Agent/Tools) | 90%+ (功能对等或增强) | 中高 |
| 后端存储/搜索 (Knowledge/Index) | 85%+ (架构不同但功能对等) | 中 |
| 后端技能系统 (Skills/Prompts) | 95%+ | 高 |
| 后端媒体管线 (Media/Image/Video) | 70%+ (部分可能移至前端) | 中 |
| 后端特殊功能 (LSP/YouTube/字幕) | 50%以下 (可能被移除) | 低 |
| 构建/部署配置 | 100% (完全替换) | 高 |

---

> **报告完毕**。本报告基于文件级差异分析生成，未包含运行时行为验证。建议配合功能测试确认各模块的实际运行状态。
