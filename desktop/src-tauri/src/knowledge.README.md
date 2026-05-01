# `knowledge.rs` 模块

## 职责

- 提供知识库 workspace-first 写入与变更操作。
- 提供纯图片素材的 workspace-first 导入操作，统一落到 `workspace/media/**`。
- 定义统一 ingest contract，供旧 IPC、本地 HTTP、未来其他 adapter 复用。
- 在落盘后刷新 knowledge 投影，并发出兼容事件。

## 当前覆盖

- `knowledge:ingest-entry`
- `knowledge:ingest-document-source`
- `knowledge:ingest-media-assets`
- `knowledge:batch-ingest`
- `knowledge:health`
- `youtube:save-note`
- `knowledge:delete-youtube`
- `knowledge:retry-youtube-subtitle`
- `knowledge:youtube-regenerate-summaries`
- `knowledge:delete`
- `knowledge:transcribe`
- `knowledge:docs:add-*`
- `knowledge:docs:delete-source`

## 约束

- `workspace/knowledge/**` 是知识内容真相源。
- `workspace/media/**` 是通过本模块导入的图片素材真相源。
- `AppStore` 中的 knowledge 数据只作为投影与缓存，不应再直接成为写入真相层。
- 新入口应优先复用本模块，而不是在 command 层再次直接 `push/retain` knowledge store。
- 本地 HTTP 入口挂在 assistant daemon 上，默认根路径是 `/api/knowledge`。

## 本地 HTTP 路由

- `OPTIONS /api/knowledge/*`（浏览器插件预检）
- `GET /api/knowledge/health`
- `POST /api/knowledge/entries`
- `POST /api/knowledge/document-sources`
- `POST /api/knowledge/media-assets`
- `POST /api/knowledge/batch-ingest`
- `GET /api/accounts/health`
- `POST /api/accounts/import-sessions`
- `POST /api/accounts/{accountId}/posts/batch`
- `POST /api/accounts/{accountId}/comments/batch`
- `POST /api/accounts/{accountId}/media/batch`
- `POST /api/accounts/import-sessions/{sessionId}/complete`

本地 HTTP 响应会附带浏览器插件所需的 CORS / Private Network Access 响应头，避免出现 `health` 可访问但 `POST` 被浏览器预检拦截的情况。

`GET /api/knowledge/health` 供浏览器插件判断连接和当前空间账号状态。除原有 `counts`、`limits`、`routes` 外，响应包含：

- `connectionStatus`: `connected_without_account_profile` 或 `connected_with_account_profile`
- `accountBindingStatus`: `noAccountProfile` 或 `hasAccountProfile`
- `workspace`: 当前空间 `{ id, name }`
- `platformAccounts`: 当前空间的小红书、抖音、Bilibili 账号摘要；未绑定的平台返回 `bound: false`

账号档案主数据通过 `/api/accounts/*` 写入当前空间的 `accounts/{platform}/{accountId}/`。导入后由 `profile_learning` 写入 `distillation/evidence-pack.json`、`stats.json`、`data-draft.md`、`ai-distillation-task.md` 和 `quality-report.json`，再更新 `CreatorProfile.md`、`writing-style-skill/SKILL.md` 与 `memory-candidates.json`。知识库保存仍保留为兼容投影，不作为账号历史的主存储。

Renderer 可通过 `accounts:health` 和 `accounts:list` 读取同一份账号 catalog。

## 当前 ingest 类型

- `entries`
  - `youtube-video`
  - `xhs-note`
  - `xhs-video`
  - `link-article`
  - `wechat-article`
  - `knowledge-note`
  - `webpage`
  - `article`
  - `text-note`
- `media-assets`
  - 目前仅支持图片素材，写入 `workspace/media/**`

## 来源字段

- `source.sourceDomain`：仅域名，例如 `www.xiaohongshu.com`
- `source.sourceLink`：完整链接
- `source.sourceUrl`：兼容旧客户端的镜像字段，当前等同于 `sourceLink`

## 相关本地文档

- 打包资源页：`src-tauri/resources/knowledge-api-guide.html`
