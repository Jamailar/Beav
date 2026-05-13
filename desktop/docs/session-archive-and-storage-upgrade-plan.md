---
doc_type: plan
execution_status: not_started
last_updated: 2026-05-11
owner: desktop-runtime
scope: desktop
target_files:
  - desktop/src-tauri/src/persistence/database.rs
  - desktop/src-tauri/src/commands/chat_sessions_deletion.rs
  - desktop/src-tauri/src/commands/chat_sessions_wander.rs
  - desktop/src-tauri/src/commands/chat_state.rs
  - desktop/src-tauri/src/commands/session_transcript.rs
  - desktop/src/bridge/ipcRenderer.ts
  - desktop/src/stores/chatStore.ts
  - desktop/src-tauri/src/main.rs
success_metrics:
  - 用户删除会话 = 软删除（标记 deleted_at），不从硬盘移除文件；30 天内可在回收站恢复
  - 用户可永久清除回收站中指定会话
  - 会话写入从覆盖写改为原子写（tmp + rename），崩溃不再丢失已持久化的 bundle
  - 支持收藏/星标会话，收藏会话不出现在回收站删除候选列表中
  - 支持单会话导出 Markdown / JSON，未来支持批量导出 zip
  - 已有 IPC channel 和前端页面流程 100% 兼容
---

# 会话归档与长期储存升级计划

## 0. 背景与动机

当前 RedConvert 的会话生命周期存在三个硬伤：

1. **删除即毁灭**：`chat_sessions_deletion.rs` 对每个会话执行「删 bundle 文件 → 删 transcript 文件 → SQLite DELETE 行」三步硬删除。无归档、无软删除、无回收站。
2. **写入非原子**：`save_session_bundle_sync` 对 `{sessionId}.json` 做 `fs::write` 原地覆盖。写入中途崩溃 → 文件损坏或丢失当前会话内容。
3. **无导出/备份**：用户无法把会话导出到任意位置保存或迁移。`session_transcript.rs` 的 Markdown 是为 AI 复盘内部使用，不是面向用户的导出。

对比 Codex 的 thread 管理（`codex-rs/state/src/runtime/threads.rs`），Codex 具备：
- `archived` + `archived_at` 归档机制
- `deleted_at` 软删除 + `list_deleted_threads` 回收站
- `starred` 收藏标记
- `rollout_path` 指向 JSONL 追加日志，append-only 写入
- `ThreadFilterOptions` 支持 archived_only / starred_only / before_id / limit 等多维过滤

本计划目标：在不破坏现有 IPC 和页面流程的前提下，逐步引入软删除、原子写入、收藏、导出四大能力，把会话存储从「脆弱覆盖写 + 硬删除」升级为「可靠追加/原子写 + 全生命周期管理」。

---

## 1. 现有架构详解

### 1.1 RedConvert 会话存储四层模型

```
┌─────────────────────────────────────────────────────┐
│  内存层  ChatState (AppStore.chat_sessions)          │
│  HashMap<SessionId, ChatStateEntry>                 │
│  含: 流式 token buffer、工具调用进度、锁状态         │
├─────────────────────────────────────────────────────┤
│  SQLite  redbox.db → chat_sessions 表                │
│  CREATE TABLE chat_sessions (                        │
│    id TEXT PRIMARY KEY,                              │
│    metadata TEXT   -- JSON blob (title/model/时间等) │
│  )                                                   │
├─────────────────────────────────────────────────────┤
│  文件层  session-bundles/{sessionId}.json            │
│  完整对话内容: messages[]、runtime state、media refs │
│  每次 save_session_bundle_sync 全量覆盖写入          │
├─────────────────────────────────────────────────────┤
│  文件层  session-transcripts/{sessionId}.md          │
│  人类可读 Markdown 对话记录（AI 复盘用）             │
└─────────────────────────────────────────────────────┘
```

关键文件及职责：

| 文件 | 职责 |
|---|---|
| `persistence/database.rs` | SQLite 初始化（创建 `chat_sessions` 表）、migration |
| `commands/chat_state.rs` | 内存层 `ChatState`：会话的打开/关闭/流式写入 |
| `commands/chat_sessions_wander.rs` | 会话列表查询、创建、bundle 写入、session list 返回（约 58KB 大文件） |
| `commands/chat_sessions_deletion.rs` | 硬删除：删 bundle 文件 + transcript 文件 + SQLite DELETE |
| `commands/chat_sessions_plain.rs` | 简化会话操作（标题编辑等） |
| `commands/session_transcript.rs` | Markdown transcript 生成与保存 |
| `commands/chat_dispatch.rs` | 消息分发入口 |
| `chat_binding.rs` | chat:* IPC channel 注册 |

### 1.2 现有删除流程（硬删除）

`chat_sessions_deletion.rs` 的删除路径：

```
Tauri command: chat:delete-sessions
  └─ delete_chat_sessions_handler()
       ├─ 对每个 sessionId:
       │   ├─ delete_session_bundle(session_id)      → fs::remove_file .json
       │   ├─ delete_session_transcript_file(session_id) → fs::remove_file .md
       │   └─ DELETE FROM chat_sessions WHERE id = ?   → SQLite 删除行
       └─ 清理内存状态
```

**问题**：
- 无提示确认后立刻不可逆删除
- 即使 bundle 文件删除失败、SQLite 行删除成功，也会产生僵尸行
- 三步骤不在同一事务中

### 1.3 现有写入流程（覆盖写）

`chat_sessions_wander.rs` 的持久化路径：

```
AI turn 结束
  └─ write_all_to_session_bundle_file(session_id, content)
       └─ fs::write(bundle_dir/{session_id}.json, content)
            ↑ 原地覆盖，无 tmp 文件，无原子 rename
```

**问题**：
- 崩溃在 `fs::write` 中间 → 文件可能部分写入，下次加载 JSON 解析失败
- 如果加载 bundle 文件失败，fallback 行为可能丢失整个会话的消息

---

## 2. Codex 线程（会话）管理架构

### 2.1 Codex SQLite schema

```sql
-- codex_state.db → threads 表
CREATE TABLE threads (
    id                TEXT PRIMARY KEY,
    title             TEXT,
    role              TEXT,
    cwd               TEXT,
    git_branch        TEXT,
    rollout_path      TEXT,       -- 指向 JSONL 追加日志文件
    metadata          BLOB,       -- protobuf ThreadMetadata
    starred           INTEGER,    -- 0/1
    archived          INTEGER,    -- 0/1
    archived_at       INTEGER,    -- nullable Unix epoch seconds
    provider_metadata BLOB,
    created_at        INTEGER,
    updated_at        INTEGER,
    deleted_at        INTEGER     -- nullable → 软删除标记
);
```

### 2.2 Codex 线程生命周期

```
create          → INSERT ... (archived=0, starred=0, deleted_at=NULL)
archive         → UPDATE SET archived=1, archived_at=now()
unarchive       → UPDATE SET archived_at=NULL, archived=0
star            → UPDATE SET starred=1
unstar          → UPDATE SET starred=0
soft-delete     → UPDATE SET deleted_at=now()
hard-delete     → DELETE FROM threads WHERE id=? (清理用)
list            → SELECT ... WHERE deleted_at IS NULL [AND archived=0/1]
list-deleted    → SELECT ... WHERE deleted_at IS NOT NULL
```

关键实现位置：`codex-rs/state/src/runtime/threads.rs`
- `mark_archived()` — line ~500
- `mark_unarchived()` — line ~530
- `mark_starred()` / `mark_unstarred()` — line ~460/480
- `delete_thread()` — line ~909（SET deleted_at = unixepoch）
- `list_deleted_threads()` — line ~550
- `ThreadFilterOptions` → `push_thread_filters()` — 支持 archived_only, starred_only, tag 等

### 2.3 Codex 存储模型：Recorder + 追加写入

```
每个 AI turn 生成一个 immutable Record
  └─ Recorder 追加写入 rollout JSONL 文件
       ├─ 永不覆盖旧数据
       ├─ 崩溃只影响最后一个未完成的 Record（重放时丢弃末尾半行）
       └─ 天然支持 undo / branch / retry / 时间旅行
```

### 2.4 Codex 前端协议

```
thread/archive    → { thread_id }
thread/unarchive  → { thread_id }
thread/read       → { thread_id }
thread/list       → { ...filters }
thread/fork       → { thread_id }
```

---

## 3. 差距矩阵

| 维度 | RedConvert 当前状态 | Codex | 差距严重度 |
|---|---|---|---|
| **删除策略** | 硬删除（删文件 + SQL DELETE） | 软删除（deleted_at 标记）+ 回收站列表 | 🔴 致命 |
| **可恢复性** | 无 | 可恢复，直到用户主动永久清除 | 🔴 致命 |
| **写入原子性** | fs::write 原地覆盖，无原子保证 | JSONL append-only + 末尾半行丢弃 | 🟠 高风险 |
| **崩溃恢复** | 崩溃可损坏 bundle JSON | 崩溃最多丢失最后一个未完成 Record | 🟠 高风险 |
| **存储模型** | 全量覆盖 JSON | 追加 Record（可回溯任意 turn） | 🟡 中长期差距 |
| **归档机制** | 无 | archived + archived_at + unarchive | 🔴 缺失 |
| **收藏/星标** | 无 | starred 字段 | 🟡 缺失 |
| **导出功能** | 无用户导出 | 可通过 Record 序列化导出任意格式 | 🟡 缺失 |
| **元数据丰富度** | id + metadata TEXT (JSON) | 14 列结构化字段 | 🟡 偏薄 |
| **过滤/排序** | 基础时间排序 | archived_only/starred_only/tag/limit/before_id | 🟡 偏弱 |

---

## 4. 实施计划

### Phase 0 — 软删除 + 回收站（P0，1-2 天）

**目标**：用户删除会话时不再丢失数据，可在回收站恢复。

**Rust 后端改动**：

#### 4.0.1 数据库 migration

`persistence/database.rs` — 在 `chat_sessions` 表添加列：

```sql
ALTER TABLE chat_sessions ADD COLUMN deleted_at INTEGER;   -- nullable Unix epoch ms
ALTER TABLE chat_sessions ADD COLUMN starred INTEGER DEFAULT 0;
ALTER TABLE chat_sessions ADD COLUMN archived INTEGER DEFAULT 0;
ALTER TABLE chat_sessions ADD COLUMN archived_at INTEGER;  -- nullable
```

Migration 需用 `PRAGMA user_version` 做版本管理（当前若无版本号，从 version=1 开始）。

#### 4.0.2 新增 command：`chat:archive-sessions`

`chat_sessions_deletion.rs` 新增：

```rust
#[tauri::command]
async fn archive_chat_sessions(
    state: State<'_, AppStore>,
    session_ids: Vec<String>,
) -> Result<(), String> {
    // 对每个 session_id:
    //   UPDATE chat_sessions SET deleted_at = ? WHERE id = ?
    // 不删文件，不删 bundle，不删 transcript
    // 从内存 ChatState 清理活跃会话引用（如果打开）
}
```

#### 4.0.3 新增 command：`chat:restore-sessions`

```rust
#[tauri::command]
async fn restore_chat_sessions(
    state: State<'_, AppStore>,
    session_ids: Vec<String>,
) -> Result<(), String> {
    // UPDATE chat_sessions SET deleted_at = NULL WHERE id = ?
}
```

#### 4.0.4 新增 command：`chat:purge-sessions`（永久删除）

```rust
#[tauri::command]
async fn purge_chat_sessions(
    state: State<'_, AppStore>,
    session_ids: Vec<String>,
) -> Result<(), String> {
    // 执行现有硬删除逻辑：
    //   delete_session_bundle + delete_session_transcript + SQLite DELETE
    // 此命令只在回收站页面的「永久删除」按钮触发
}
```

#### 4.0.5 修改 `chat:list-sessions`

`chat_sessions_wander.rs` — 默认排除已删除会话：

```rust
// list_sessions_handler 查询改为：
// SELECT ... FROM chat_sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC
```

新增 `chat:list-archived-sessions` 或 `chat:list-sessions` 加 filter 参数：

```rust
#[tauri::command]
async fn list_archived_sessions(
    state: State<'_, AppStore>,
) -> Result<Vec<SessionSummary>, String> {
    // SELECT ... FROM chat_sessions WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC
}
```

#### 4.0.6 注册新 IPC channel

`chat_binding.rs` / `main.rs`：

```
chat:archive-sessions
chat:restore-sessions
chat:purge-sessions
chat:list-archived-sessions
```

**前端改动**：

#### 4.0.7 Bridge 层

`desktop/src/bridge/ipcRenderer.ts` 新增：

```typescript
export const archiveSessions = (sessionIds: string[]) =>
  ipcRenderer.invoke('chat:archive-sessions', { sessionIds });

export const restoreSessions = (sessionIds: string[]) =>
  ipcRenderer.invoke('chat:restore-sessions', { sessionIds });

export const purgeSessions = (sessionIds: string[]) =>
  ipcRenderer.invoke('chat:purge-sessions', { sessionIds });

export const listArchivedSessions = () =>
  ipcRenderer.invoke('chat:list-archived-sessions');
```

#### 4.0.8 UI 改动

- 会话列表的删除按钮：调用 `archiveSessions` 替代原有 `deleteSessions`
- 新增「回收站」页面/侧栏入口，调用 `listArchivedSessions` 展示已归档会话
- 回收站中每项提供「恢复」和「永久删除」按钮
- 永久删除时二次确认弹窗

**验收标准**：
- 删除会话 → 会话从主列表消失，出现在回收站
- 回收站中恢复 → 会话回到主列表，bundle/transcript 完整
- 回收站中永久删除 → 会话彻底清除
- 刷新页面后回收站数据不丢失

---

### Phase 1 — 原子写入 + 一致性保障（P1，2-3 天）

**目标**：消除 bundle JSON 覆盖写的 split-brain 和崩溃损坏风险。

#### 4.1.1 原子写入 bundle

`chat_sessions_wander.rs` — `write_all_to_session_bundle_file` 改为：

```rust
fn save_session_bundle_atomic(session_id: &str, content: &str) -> Result<(), Error> {
    let bundle_dir = get_session_bundles_dir();
    let final_path = bundle_dir.join(format!("{}.json", session_id));
    let tmp_path = bundle_dir.join(format!("{}.json.tmp", session_id));
    
    // 1. 写 .tmp 文件
    fs::write(&tmp_path, content)?;
    
    // 2. 原子 rename（POSIX 保证原子性）
    fs::rename(&tmp_path, &final_path)?;
    
    Ok(())
}
```

#### 4.1.2 写入前完整性校验

在写入前对 content 做 JSON 合法性校验，避免写入损坏数据：

```rust
// 写入前：serde_json::from_str::<Value>(content)?; // panic on invalid
// 写入后（可选）：读取并校验首尾字节完整性
```

#### 4.1.3 加载时的降级恢复

```rust
fn load_session_bundle(session_id: &str) -> Result<Value, Error> {
    match fs::read_to_string(bundle_path) {
        Ok(content) => serde_json::from_str(&content).map_err(...),
        Err(_) => {
            // 尝试 tmp 文件恢复
            if let Ok(content) = fs::read_to_string(tmp_path) {
                if let Ok(value) = serde_json::from_str(&content) {
                    // tmp 文件内容完整 → 用它
                    fs::rename(&tmp_path, &bundle_path)?;
                    return Ok(value);
                }
            }
            // 都不可用 → 空会话（元数据还在 SQLite）
            Ok(Value::Object(Default::default()))
        }
    }
}
```

**验收标准**：
- 写入 bundle 过程中强杀进程 → .json 文件要么完整（rename 成功）要么是旧版本（rename 未执行）
- 不存在半写入的损坏 JSON
- tmp 残留文件在下次加载时自动恢复

---

### Phase 2 — 追加存储模型（P2，中长期，3-5 天）

**目标**：借鉴 Codex 的 Recorder 模式，把覆盖写改为 turn 级追加。

#### 4.2.1 Turn 文件格式

```
session-turns/{sessionId}/
  ├── 0001.json   # Turn 1 (user + assistant + tool calls)
  ├── 0002.json   # Turn 2
  ├── 0003.json   # Turn 3
  └── manifest.json  # { version, turn_count, checksums }
```

#### 4.2.2 写入

每次 AI turn 完成时：
1. 生成 `turn_N.json`（N = 当前最大 turn 号 + 1）
2. 写 `turn_N.json.tmp` → rename → `turn_N.json`
3. 更新 `manifest.json`（原子写入）

#### 4.2.3 加载

按 `manifest.json` 中的 turn_count，依次加载 `0001.json` ~ `{N}.json`，合并为完整消息列表。

#### 4.2.4 收益

- 编辑/重试某条消息 → 只需替换对应 turn 文件
- 回退到某 turn → 截断 manifest turn_count
- 分支对话 → 复制 turns 目录，从某 turn 开始新分支
- 崩溃 → 最多丢失最后一个 turn

**注意**：此 Phase 改动面较大（writer + reader + merge + GC），需在 Phase 0/1 稳定后再启动，且必须向后兼容原有的单 bundle JSON 文件格式。

---

### Phase 3 — 导出功能（P3，1-2 天）

**目标**：用户可将会话导出为 Markdown / JSON 文件，支持单会话和批量。

#### 4.3.1 单会话导出

新增 Tauri command `chat:export-session`：

```rust
#[tauri::command]
async fn export_session(
    state: State<'_, AppStore>,
    session_id: String,
    format: String,  // "markdown" | "json"
    dest_path: Option<String>,  // 用户选择的保存路径
) -> Result<String, String> {
    // "markdown" → 复用现有 transcript 内容，写入 dest_path
    // "json" → 读取 bundle + metadata，打包为 JSON，写入 dest_path
    // 返回实际保存路径
}
```

#### 4.3.2 批量导出

```rust
#[tauri::command]
async fn export_sessions(
    state: State<'_, AppStore>,
    session_ids: Vec<String>,
    format: String,
    dest_dir: String,
) -> Result<Vec<String>, String> {
    // 遍历 session_ids，分别调用单会话导出
    // 可选：打包为 .zip（用 zip crate）
}
```

#### 4.3.3 前端交互

- 会话右键菜单 / 更多操作 →「导出为 Markdown」「导出为 JSON」
- 使用 Tauri `dialog` API 让用户选择保存路径
- 批量导出：回收站或多选模式中「批量导出」按钮

**验收标准**：
- 导出 Markdown → 文件可被任意 Markdown 阅读器正常渲染
- 导出 JSON → 文件包含完整 metadata + messages + media refs，可被同 app 重新导入
- 导出到不存在目录时自动创建

---

### Phase 4 — 收藏/星标（P4，0.5-1 天）

**目标**：用户可以收藏重要会话，收藏会话在删除确认时给出更强提示。

#### 4.4.1 后端

```rust
#[tauri::command]
async fn star_session(state: State<'_, AppStore>, session_id: String) -> Result<(), String> {
    // UPDATE chat_sessions SET starred = 1 WHERE id = ?
}

#[tauri::command]
async fn unstar_session(state: State<'_, AppStore>, session_id: String) -> Result<(), String> {
    // UPDATE chat_sessions SET starred = 0 WHERE id = ?
}
```

#### 4.4.2 `list_sessions` 增强

```rust
struct SessionFilter {
    starred_only: Option<bool>,
    archived_only: Option<bool>,
    limit: Option<u32>,
    before_id: Option<String>,
}
```

#### 4.4.3 前端

- 会话列表每项左侧加星标图标（☆/★）
- 顶部加「仅显示收藏」筛选开关
- 删除已收藏会话时额外确认：「此会话已收藏，确定要归档吗？」

---

## 5. 实施顺序与依赖关系

```
Phase 0 (软删除 + 回收站) ← 本周启动，最紧急
  │
  ├─ 前置：无
  ├─ 产出：archive/restore/purge command + 回收站 UI
  │
Phase 1 (原子写入) ← 依赖 Phase 0 完成，防止写入路径改动互相冲突
  │
  ├─ 前置：Phase 0 的 session_bundle 写入路径已稳定
  ├─ 产出：tmp+rename 替换 fs::write
  │
Phase 4 (收藏) ← 可与 Phase 1 并行，改动面独立
  │
  ├─ 前置：Phase 0 的 schema migration（starred 列已在 Phase 0 添加）
  ├─ 产出：star/unstar + 列表过滤
  │
Phase 3 (导出) ← 依赖 Phase 1 的可靠写入保证导出内容完整性
  │
  ├─ 前置：Phase 1
  ├─ 产出：单会话/批量导出 Markdown + JSON
  │
Phase 2 (追加存储) ← 中长期，依赖 Phase 1 稳定运行后评估
  │
  ├─ 前置：Phase 0 + Phase 1 全部完成并稳定
  ├─ 产出：turn 级追加文件替代覆盖写 bundle
```

---

## 6. 回滚策略

每个 Phase 独立可回滚：

- **Phase 0**：软删除同时保留旧 `delete-chat-sessions` command 不变；回收站页面不展示时，后端行为等同于硬删除场景（但数据仍在）。如需回滚，移除回收站 UI + 把删除按钮改回调用旧 command。
- **Phase 1**：原子写入逻辑封装在 `save_session_bundle_atomic` 函数内；回滚只需把调用点改回 `fs::write`。
- **Phase 3**：导出是纯新增功能，无回滚需求。
- **Phase 4**：starred 列在 Phase 0 migration 已添加；前端不展示则等于不启用。
- **Phase 2**：新增 turns 目录，不影响旧 bundle 文件；加载时优先检查 turns 目录，不存在则 fallback 到旧的单 bundle JSON。

---

## 7. 待确认事项

1. **回收站保留时长**：归档会话在回收站保留 N 天后自动永久清除？（建议 30 天，可在设置中配置）
2. **自动永久清除的调度**：是否复用 RedClaw scheduler？还是简单的 startup check？
3. **导入功能**：是否需要「从导出的 JSON 文件重新导入会话」？需要定义兼容的 JSON schema。
4. **session-bundle 迁移**：Phase 2 追加存储落地后，旧 bundle JSON 是否需要一次性迁移到 turns 格式？还是保持双格式加载兼容？
5. **空间管理**：是否需要在设置页面显示 session-bundles + session-transcripts 的总占用空间？