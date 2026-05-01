# P0-1 Settings + FileIndexDashboard 集成测试报告

> 测试日期: 2026-04-30 | 测试人: tester | 方案: P0-1-settings-visual-index-plan.md

---

## 1. 编译检查 ✅ 通过

```
cd archive/desktop-electron && npx tsc --noEmit
```

**结果**: 仅 1 个预存错误（`useOfficialAuthState.ts:39` — 与 P0-1 无关），零新增编译错误。P0-1 所有新增类型和组件编译通过。

---

## 2. 类型完整性 ⚠️ 基本一致，1 处缺失

### 2.1 前端类型定义 (SettingsSections.tsx L86-120)

| 类型 | 字段 | 状态 |
|------|------|------|
| `FileIndexLaneStatus` | lane, label, status, done, total, failed, metadataOnly?, lastUpdatedAt?, nextRetryAt? | ✅ |
| `FileIndexScopeStatus` | scopeId, name, scopeType, ownerId?, ownerName?, fileCount, status, failedCount, lanes: FileIndexLaneStatus[] | ✅ |
| `FileIndexDashboard` | overall { status, indexedFiles, totalFiles, failedFiles, lastIndexedAt? }, lanes: FileIndexLaneStatus[], scopes: FileIndexScopeStatus[] | ✅ |

### 2.2 后端类型定义 (file_index_dashboard.rs L15-59)

| 类型 | 字段 | 状态 |
|------|------|------|
| `FileIndexDashboard` | overall, lanes, scopes | ✅ |
| `FileIndexLaneStatus` | lane, label, status, done, total, failed, metadata_only, last_updated_at, next_retry_at | ✅ |
| `FileIndexScopeStatus` | scope_id, name, scope_type, owner_id, owner_name, file_count, status, failed_count, lanes | ✅ |

Rust `#[serde(rename_all = "camelCase")]` 保证序列化后与前端 camelCase 字段名一致。

### 2.3 types.d.ts 声明 (L1326)

```typescript
getFileIndexDashboard: <T = Record<string, unknown>>() => Promise<T>;
```

- ✅ `getFileIndexDashboard` 已声明
- ❌ **`getFileIndexScopeStatus` 未声明** — 方案规划了两个 IPC 通道，types.d.ts 中只声明了一个
- ⚠️ 泛型默认值使用 `Record<string, unknown>` 而非具体类型 `FileIndexDashboard`（运行时无影响，仅 IDE 类型提示较弱）

### 2.4 SettingsFormData 字段计数

| 字段群 | 方案规划 | 实际实现 |
|--------|---------|---------|
| Visual Index | 12 | 12 ✅ |
| Document Parser | 6 (含 `parser_max_file_size`) | 5 ❌ 缺少 `parser_max_file_size` |
| Rerank | 4 | 4 ✅ |
| **总计** | **22** | **21** |

字段 `parser_max_file_size` 在方案中列出但未在实际 `formData` 初始化和序列化代码中找到。

---

## 3. IPC 通道 ⚠️ 1/2 已实现

### 通道 1: `knowledge:getFileIndexDashboard` ✅

| 层级 | 位置 | 状态 |
|------|------|------|
| types.d.ts | L1326 | ✅ |
| bridge/ipcRenderer.ts (映射) | L32: `'knowledge:get-file-index-dashboard': 'knowledge_get_file_index_dashboard'` | ✅ |
| bridge/ipcRenderer.ts (封装) | L703-706: `getFileIndexDashboard` | ✅ |
| Tauri main.rs (注册) | L9648 | ✅ |
| Tauri library.rs (handler) | L896-901 | ✅ |
| Rust 实现 | `file_index_dashboard.rs::dashboard()` | ✅ |

### 通道 2: `knowledge:getFileIndexScopeStatus` ❌ 未实现

| 层级 | 状态 |
|------|------|
| types.d.ts | ❌ 无声明 |
| ipcRenderer.ts | ❌ 无封装 |
| Tauri backend | ❌ 无 handler |

方案中规划的第二个 IPC 通道 `knowledge:get-file-index-scope-status` 在所有三层中均未实现。**这是方案与实现之间最大的差异**。

### preload.ts

Tauri 应用中不使用传统的 Electron `contextBridge`。IPC 通过 Tauri 的 `invoke` 机制自动暴露（main.rs 中注册的 command 自动可用）。`ipcRenderer.ts` 作为统一的 IPC 抽象层调用 `invokeCommand`。✅ 架构正确。

---

## 4. DB Schema ⚠️ 与方案不同，但实现路径有效

### 方案预期 (Electron 迁移)

方案描述了 `file_index_lanes` 和 `file_index_events` 两张新表 + SQLite 迁移脚本，这个设计是针对 Electron (better-sqlite3) 的。

### 实际实现 (Tauri)

- 无独立 SQL 迁移文件 (`.sql` 文件不存在)
- 无 `file_index_lanes` / `file_index_events` 表
- 后端 `file_index_dashboard.rs` 从 **catalog DB** (SQLite via rusqlite) 直接查询
- 状态聚合逻辑在 Rust 代码中完成（`dashboard()` 函数查询 scopes、sources、vectors 表并聚合为 Dashboard 结构）

### 评估

实现路径有效但偏离了方案。方案中的 `file_index_lanes`/`file_index_events` 表提供了精细化的进度追踪能力（per-lane 状态、重试时间、事件日志），当前实现直接从现有 catalog 表聚合，缺少：
- Per-lane 的实时进度（`done`/`total` 为聚合快照）
- 失败重试时间戳（`next_retry_at`）
- 索引事件日志（`file_index_events` 表）

**建议**: 如果需要精细化索引进度追踪，应按照方案实现 `file_index_lanes` 表。

---

## 5. 前端组件 ✅ 全部正确

### 5.1 新组件 (5 个)

| 组件 | 位置 | 状态 |
|------|------|------|
| `FileIndexStatusBadge` | SettingsSections.tsx L437-443 | ✅ 彩色状态徽章 |
| `FileIndexProgressText` | SettingsSections.tsx L445-465 | ✅ 进度文本 (done/total + metadata/failed) |
| `FileIndexSettingsPanel` | SettingsSections.tsx L468-561 | ✅ 核心面板 (概览 + lanes 表格 + scopes 表格 + 刷新按钮) |
| `fileIndexStatusLabel/ScopeLabel/StatusClass` | SettingsSections.tsx L413-435 | ✅ 辅助函数 |
| `ExperimentalSettingsSection` | SettingsSections.tsx L978-1118 | ✅ 文档解析 + 重排配置面板 |

### 5.2 组件引用和渲染

| 引用点 | 状态 |
|--------|------|
| `SettingsTab` 包含 `'experimental'` (L129) | ✅ |
| tabs 数组包含 `{ id: 'experimental', label: '实验功能', icon: FlaskConical }` (L4727) | ✅ |
| `ExperimentalSettingsSection` 导入 (L85) | ✅ |
| `FileIndexDashboard` type 导入 (L88) | ✅ |
| `activeTab === 'experimental'` 渲染分支 (L4790) | ✅ |
| `GeneralSettingsSection` 传递 fileIndex props (L4768-4772) | ✅ |
| `GeneralSettingsSectionInner` 渲染 `<FileIndexSettingsPanel>` (L667-671) | ✅ |
| `preserveLocalFormState` 包含 `'experimental'` (L4213) | ✅ |

### 5.3 空状态/Loading 处理

| 场景 | 处理方式 | 状态 |
|------|---------|------|
| lanes 数组为空 | 显示 "暂无索引记录" | ✅ |
| scopes 数组为空 | 显示 "暂无知识库索引记录" | ✅ |
| dashboard 为 null | `summaryText` fallback "索引状态未加载" | ✅ |
| loading 状态 | 刷新按钮 disabled + spinner 动画 | ✅ |

---

## 6. 数据流 ⚠️ 基本完整，1 处字段缺失

### 6.1 加载链路

```
activeTab === 'general' → useEffect (L4277)
  → loadFileIndexDashboard({ force: true, background: true })
    → 检查缓存 TTL (FILE_INDEX_DASHBOARD_CACHE_TTL_MS)
    → 重复请求去重 (fileIndexDashboardInFlightRef)
    → setIsFileIndexDashboardLoading(true)
    → window.ipcRenderer.knowledge.getFileIndexDashboard()
    → 响应验证 (isEmptyFileIndexDashboardFallback)
    → 缓存写入 (writeCachedFileIndexDashboard → localStorage)
    → setFileIndexDashboard(nextDashboard)
    → setIsFileIndexDashboardLoading(false)
```

### 6.2 缓存链路

| 函数 | 位置 | 状态 |
|------|------|------|
| `readCachedFileIndexDashboard()` | L488-503 | ✅ JSON.parse + 类型验证 + TTL 校验 |
| `writeCachedFileIndexDashboard()` | L505-517 | ✅ JSON.stringify + 返回 Date.now() |
| `clearCachedFileIndexDashboard()` | L519-523 | ✅ localStorage.removeItem |

### 6.3 保存链路

```
Settings save →
  visual_index 字段: normalizeVisualIndexPromptVersion → payload 序列化 (L4639-4650)
  docling/tika/unstructured 字段: String.trim() (L4651-4653)
  rerank 字段: String.trim() (L4656-4659)
```

### 6.4 刷新链路

```
handleRefreshFileIndexDashboard → loadFileIndexDashboard({ force: true })
  → 跳过缓存 TTL 检查
  → 重新 IPC 调用
```

### 6.5 缺失字段

`parser_max_file_size` 在方案中定义为表单字段但在实际的 `loadBaseSettings`/`saveSettings` 中未找到序列化逻辑。ExperimentalSettingsSection UI 中也未渲染此字段。

---

## 7. 边界情况 ✅ 覆盖良好

| 场景 | 处理 | 状态 |
|------|------|------|
| `dashboard` 为 null | `isEmptyFileIndexDashboardFallback(null)` → true | ✅ |
| `dashboard` 全部为零 | `isEmptyFileIndexDashboardFallback` 检查 lanes/scopes/overall 均为零 | ✅ |
| 新返回空 dashboard 但缓存有数据 | 保持旧缓存值 (L2317-2324) | ✅ |
| IPC 调用失败 | try/catch → console.error → 返回旧值 | ✅ |
| 重复并发请求 | `fileIndexDashboardInFlightRef` 去重 (L2299-2301) | ✅ |
| 请求竞态 | `requestId` 递增 + 回调时校验 (L2303, L2313) | ✅ |
| 后台加载 + 无缓存 | 仍然显示 loading (L2304) | ✅ |
| 后台加载 + 有缓存 | 不显示 loading (L2304) | ✅ |
| 缓存过期 (TTL) | 自动强制刷新 (L2295) | ✅ |
| 工作区切换时 | `clearCachedFileIndexDashboard()` + `setFileIndexDashboard(null)` (L4246-4249) | ✅ |
| 不支持的 lane status | `fileIndexStatusLabel` fallback "未知" | ✅ |
| 不支持的 scopeType | `fileIndexScopeLabel` fallback "知识库" | ✅ |

---

## 总结

| 测试项 | 结果 | 关键发现 |
|--------|------|---------|
| 1. 编译检查 | ✅ 通过 | 零新增错误 |
| 2. 类型完整性 | ⚠️ 基本一致 | `getFileIndexScopeStatus` 未在 types.d.ts 声明；缺少 `parser_max_file_size` 字段 |
| 3. IPC 通道 | ⚠️ 1/2 已实现 | `getFileIndexDashboard` 完整贯通；`getFileIndexScopeStatus` 未实现 |
| 4. DB Schema | ⚠️ 偏离方案 | 未创建 `file_index_lanes`/`file_index_events` 表，从 catalog DB 直接聚合 |
| 5. 前端组件 | ✅ 通过 | 5 个新组件全部正确渲染，引用无误 |
| 6. 数据流 | ⚠️ 基本完整 | 加载/缓存/保存/刷新链路完整；缺少 `parser_max_file_size` |
| 7. 边界情况 | ✅ 通过 | null/空值/错误/并发/切换 均有处理 |

### 需跟进事项

1. **P1** `getFileIndexScopeStatus` IPC 通道：按方案在 types.d.ts、ipcRenderer.ts、Tauri backend 三层补齐
2. **P2** `parser_max_file_size` 字段：在 formData、序列化逻辑、ExperimentalSettingsSection UI 中补齐
3. **P2** `file_index_lanes` / `file_index_events` 表：评估是否需要精细化索引进度追踪，若需要则按方案建表
4. **P3** types.d.ts 泛型优化：将 `getFileIndexDashboard` 的默认泛型从 `Record<string, unknown>` 改为具体类型 `FileIndexDashboard`
