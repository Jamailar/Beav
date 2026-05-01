# P0-1 Settings + FileIndexDashboard 实施方案

> 日期: 2026-04-30 | 差异程度: 大 (1703 diff lines) | 预计工作量: 3-5 天

---

## 一、差异总览

| 维度 | 旧版 (Electron) | 新版 (Tauri) |
|------|----------------|-------------|
| Settings 标签页 | 5 (`general`, `ai`, `tools`, `profile`, `remote`) | 6 (新增 `experimental`) |
| SettingsFormData 字段 | ~30 | ~52 (新增 ~22 个) |
| FileIndexDashboard | 无 | 全新组件 |
| Visual Index 配置 | 无 | 12 个配置字段 |
| 文档解析配置 | 无 | 3 端点 + API Key + 文件大小限制 |
| 重排服务配置 | 无 | 4 字段 (端点/模型/Key/超时) |
| 新 IPC 通道 | 无 | 2 个 (`knowledge:getFileIndexDashboard`, `knowledge:getFileIndexScopeStatus`) |

---

## 二、逐文件差异清单

### 2.1 Settings.tsx (桌面: ~4800 行, 旧版: ~3950 行)

#### (A) 类型/常量新增

| 新增项 | 位置 | 说明 |
|--------|------|------|
| `SettingsTab` 新增 `'experimental'` | L129 | 标签页类型扩展 |
| `ExperimentalSettingsSection` import | L85 | 从 SettingsSections 导入 |
| `FileIndexDashboard` type import | L88 | 从 SettingsSections 导入 |
| `FileIndexDashboardCacheRecord` type | L483-486 | 缓存记录类型 `{ dashboard, savedAt }` |
| `readCachedFileIndexDashboard()` | L488-503 | localStorage 读取缓存 |
| `writeCachedFileIndexDashboard()` | L505-517 | localStorage 写入缓存 |
| `clearCachedFileIndexDashboard()` | L519-523 | localStorage 清除缓存 |
| `DEFAULT_VISUAL_INDEX_PROMPT_VERSION` | ~L540 | 默认 prompt 版本常量 |
| `normalizeVisualIndexPromptVersion()` | L136-150 | prompt 版本规范化 |

#### (B) 表单状态新增 (~22 字段)

```typescript
// Visual index 字段 (12 个)
visual_index_enabled: false,
visual_index_provider: 'openai-compatible',
visual_index_endpoint: '',
visual_index_api_key: '',
visual_index_model: '',
visual_index_prompt_version: DEFAULT_VISUAL_INDEX_PROMPT_VERSION,
visual_index_timeout_seconds: '90',
visual_index_max_image_edge: '1536',
visual_index_skip_small_images: true,
visual_index_pdf_max_pages: '12',
visual_index_pdf_render_dpi: '144',
visual_index_concurrency: '1',

// 文档解析字段 (5 个)
docling_endpoint: '',
tika_endpoint: '',
unstructured_endpoint: '',
parser_api_key: '',
parser_max_file_size: '',
parser_timeout_seconds: '60',

// 重排服务字段 (4 个)
rerank_endpoint: '',
rerank_api_key: '',
rerank_model: '',
rerank_timeout_seconds: '30',
```

#### (C) 新 State/Hook (文件索引)

| State | 行号 | 说明 |
|-------|------|------|
| `fileIndexDashboard` | L631 | `FileIndexDashboard \| null` |
| `isFileIndexDashboardLoading` | L634 | 加载状态 |
| `visualIndexSourceId` | L620 | 视觉索引 AI 源 ID |
| `fileIndexDashboardCurrentRef` | L874 | 保留上次有效值 |
| `fileIndexDashboardLoadedAtRef` | L877 | 缓存时间戳 |
| `initialFileIndexDashboardCache` | L540 | useMemo 初始缓存 |

#### (D) 新函数/Hook

| 函数 | 行号 | 用途 |
|------|------|------|
| `filterVisualIndexModels()` | L989-996 | 过滤支持视觉的模型 |
| `pickBestVisualIndexModelForSource()` | L998-1014 | 自动选择最佳视觉模型 |
| `selectedVisualIndexSource` | L1132-1134 | useMemo 当前选择的视觉源 |
| `visualIndexSourceModels` | L1148-1150 | useMemo 可用视觉模型列表 |
| `isEmptyFileIndexDashboardFallback()` | L2275-2286 | 判断 dashboard 是否为空 |
| `loadFileIndexDashboard()` | L2288-2349 | 加载/缓存/重试文件索引仪表盘 |
| `handleRefreshFileIndexDashboard` callback | L4770-4771 | 强制刷新回调 |

#### (E) 表单保存逻辑新增

| 逻辑 | 行号 | 说明 |
|------|------|------|
| `resolveLinkedSourceIdFromList()` for visual index | L3307-3310 | 根据 endpoint/model 反查 AI 源 |
| `setVisualIndexSourceId()` | L3371 | 设置当前视觉源 |
| 视觉索引字段序列化 | L3395-3406 | 读取 → formData |
| 视觉索引保存校验 | L4606 | 检查 endpoint + model 非空 |
| 视觉索引字段保存 | L4639-4650 | formData → 持久化 payload |
| 文档解析字段保存 | L4651-4653 | docling/tika/unstructured |
| 重排字段保存 | L4656-4659 | rerank endpoint/model/key/timeout |

#### (F) 标签页导航变更

| 位置 | 变更 |
|------|------|
| L4213 | `preserveLocalFormState` 加入 `'experimental'` |
| L4262 | tab 切换时加载 dashboard / refresh |
| L4270 | `useEffect` 监听 general tab 激活 → 后台加载 dashboard |
| L4769-4772 | 渲染 `GeneralSettingsSection` 时传递 `fileIndexLoading` + `handleRefreshFileIndexDashboard` |
| L4790-4791 | 新增 `activeTab === 'experimental'` 渲染分支 |

---

### 2.2 SettingsSections.tsx (桌面新增内容)

#### (A) 新类型 (3 个 export type)

| 类型 | 行号 | 字段 |
|------|------|------|
| `FileIndexLaneStatus` | L86-96 | `lane`, `label`, `status`, `done`, `total`, `failed`, `metadataOnly`, `lastUpdatedAt`, `nextRetryAt` |
| `FileIndexScopeStatus` | L98-108 | `scopeId`, `name`, `scopeType`, `ownerId`, `ownerName`, `fileCount`, `status`, `failedCount`, `lanes` |
| `FileIndexDashboard` | L110-120 | `overall` (status/indexedFiles/totalFiles/failedFiles/lastIndexedAt), `lanes`, `scopes` |

#### (B) FormsData 类型扩展

| 字段群 | 字段数 | L35-68 |
|--------|--------|--------|
| Visual Index | 12 | L47-58 |
| Document Parser | 5 (+1 超时) | L59-63 |
| Rerank | 4 | L64-67 |

#### (C) 新组件/导出 (7 个)

| 组件 | 行号 | 类型 | 功能 |
|------|------|------|------|
| `FileIndexLaneStatus` (type) | L86 | 导出类型 | Lane 级别索引进度（status/done/total/failed/metadataOnly） |
| `FileIndexScopeStatus` (type) | L98 | 导出类型 | Scope 级别索引状态（scopeId/name/fileCount/lanes） |
| `fileIndexStatusLabel()` | L413 | 辅助函数 | 状态 → 中文标签 |
| `fileIndexScopeLabel()` | L417 | 辅助函数 | scopeType → 中文 |
| `fileIndexStatusClass()` | L421 | 辅助函数 | 状态 → CSS class |
| `FileIndexStatusBadge` | L437-443 | 小组件 | 彩色状态徽章 |
| `FileIndexSettingsPanel` | L468-561 | **核心面板** | 文件索引仪表盘：概览 + FileIndexProgressText + lanes 表格 + scopes 表格 + 刷新按钮 |

#### (D) GeneralSettingsSectionInner Props 扩展

新增 3 个 prop (L572-574):
- `fileIndexDashboard: FileIndexDashboard | null`
- `fileIndexLoading: boolean`  
- `handleRefreshFileIndexDashboard: () => Promise<void>`

在组件内渲染 `<FileIndexSettingsPanel>` (约 L670 行).

#### (E) ExperimentalSettingsSection 组件 (L978-1118, 全新)

- 折叠式 "文件解析与重排" 面板
- 3 列布局: Docling / Tika / Unstructured endpoints
- 2 列布局: Parser API Key + 超时秒数
- 2 列布局: Rerank Endpoint / Model / API Key / 超时秒数
- 使用 `PasswordInput` 组件处理 API Key
- 中文 UI 标签、占位提示

---

## 三、IPC 调用链路

### 3.1 新增 IPC 通道

#### 通道 1: `knowledge:getFileIndexDashboard`

```
前端: window.ipcRenderer.knowledge.getFileIndexDashboard()
  ↓
bridge/ipcRenderer.ts L703-706:
  invokeCommand('knowledge_get_file_index_dashboard')
  ↓
后端 (Electron 需新增):
  ipcMain.handle('knowledge:get-file-index-dashboard', ...)
  ↓
执行文件索引状态查询 → 返回 FileIndexDashboard JSON
```

#### 通道 2: `knowledge:getFileIndexScopeStatus`

```
前端: window.ipcRenderer.knowledge.getFileIndexScopeStatus(scopeId)
  ↓
bridge/ipcRenderer.ts: 需新增 invokeCommand('knowledge_get_file_index_scope_status')
  ↓
后端 (Electron 需新增):
  ipcMain.handle('knowledge:get-file-index-scope-status', ...)
  ↓
按 scopeId 查询单个 Scope 的详细信息 → 返回 FileIndexScopeStatus
```

> **命名空间说明**: 两个通道均使用 `knowledge:` 命名空间（非 `db:` 或 `settings:`），因为文件索引数据来源于知识库索引引擎。`types.d.ts` 中的 IPC 接口声明也应在 `knowledge` 命名空间下。

### 3.2 现有通道复用 (无需新建)

| 通道 | 用途 |
|------|------|
| `settings:get-all` | 加载所有设置 (含新增 vi_* 字段) |
| `settings:save` | 保存设置 (含新增字段) |
| `ai-source:list` | AI 源列表 (视觉索引模型选择下拉) |
| `knowledge:rebuild-catalog` | 重建索引时可能触发视觉索引用 |

### 3.3 类型声明需要更新 (`types.d.ts`)

#### IPC 接口声明 (在 `knowledge` 命名空间下)

```typescript
// types.d.ts 新增/确认声明：

// 通道 1: 文件索引仪表盘
getFileIndexDashboard: <T = FileIndexDashboard>() => Promise<T>;

// 通道 2: 单个 Scope 状态查询
getFileIndexScopeStatus: <T = FileIndexScopeStatus>(scopeId: string) => Promise<T>;
```

> **命名空间**: 所有文件索引相关 IPC 通道使用 `knowledge:` 前缀（非 `db:` 或 `settings:`）。文件索引状态来源于知识库索引引擎的数据，而非通用设置存储。

#### 前端类型导入声明

Settings.tsx 需从 SettingsSections.tsx 导入以下类型（或从 `types.d.ts` 集中导入）：

```typescript
import type {
  FileIndexLaneStatus,
  FileIndexScopeStatus,
  FileIndexDashboard,
} from './settings/SettingsSections';
```

#### 后端类型 (Electron 主进程)

Electron 主进程需定义与前端一致的接口（可使用共享 types 或手工同步）：

```typescript
// electron/core/fileIndexTypes.ts (新建)
export interface FileIndexLaneStatus {
  lane: string; label: string; status: string;
  done: number; total: number; failed: number;
  metadataOnly: number; lastUpdatedAt: string | null;
  nextRetryAt: string | null;
}

export interface FileIndexScopeStatus {
  scopeId: string; name: string; scopeType: string;
  ownerId: string; ownerName: string;
  fileCount: number; status: string; failedCount: number;
  lanes: FileIndexLaneStatus[];
}

export interface FileIndexDashboard {
  overall: {
    status: string; indexedFiles: number;
    totalFiles: number; failedFiles: number;
    lastIndexedAt: string | null;
  };
  lanes: FileIndexLaneStatus[];
  scopes: FileIndexScopeStatus[];
}
```

---

## 四、依赖分析

### 4.1 前端新依赖

| 依赖 | 来源 | 用途 |
|------|------|------|
| `DateTimeFormat` (浏览器内置) | — | 格式化 lastIndexedAt 时间 |
| `localStorage` (浏览器内置) | — | dashboard 缓存 |
| `localAsset.ts` (shared) | `extractLocalAssetPathCandidate` | FileIndexDashboard 间接使用 |
| `modelCapabilities.ts` (shared) | `getModelInputCapabilities` | 过滤视觉模型 |
| `PasswordInput` (shared.tsx 组件) | `settings/shared.tsx` | Parser/Rerank API Key 输入 |

### 4.2 后端新依赖 (Electron 需实现)

| 功能 | 需要 |
|------|------|
| 文件索引状态查询 | 读取 Tantivy/其他索引引擎的状态 |
| 索引 rebuild 支持 `includeVisualIndex` 参数 | 扩展 `knowledge:rebuild-catalog` |
| 设置持久化 | 存储 ~22 个新设置字段 |

---

## 五、后端适配需求

### 5.1 Electron 主进程需新增的 IPC Handler

#### 通道 1: `knowledge:get-file-index-dashboard`

```typescript
// electron/main.ts 新增
import { indexManager } from './core/IndexManager';
import { getVectorStats } from './db';

ipcMain.handle('knowledge:get-file-index-dashboard', async () => {
  const status = indexManager.getStatus();
  const stats = getVectorStats();

  // IndexManager.getStatus() 返回:
  // { isIndexing, totalQueueLength, activeItems[], queuedItems[], processedCount, totalStats }
  // getVectorStats() 返回:
  // { totalVectors, totalDocuments }

  return {
    overall: {
      status: status.isIndexing ? 'indexing' : 'idle',
      indexedFiles: stats.totalDocuments,
      totalFiles: stats.totalDocuments + status.totalQueueLength,
      failedFiles: 0,   // Electron 版 IndexManager 暂无失败计数
      lastIndexedAt: null // 可扩展 db.getLastIndexedAt()
    },
    lanes: buildLanesFromStatus(status, stats),
    scopes: await buildScopesFromDb()
  };
});
```

#### 通道 2: `knowledge:get-file-index-scope-status`

```typescript
ipcMain.handle('knowledge:get-file-index-scope-status', async (_event, scopeId: string) => {
  // 从 better-sqlite3 按 scopeId 查询 scope 详情
  const scopeRow = db.prepare(`
    SELECT s.id as scopeId, s.name, s.type as scopeType,
           s.owner_id as ownerId, s.owner_name as ownerName,
           COUNT(v.id) as fileCount
    FROM scopes s
    LEFT JOIN knowledge_vectors v ON v.source_id = s.id
    WHERE s.id = ?
    GROUP BY s.id
  `).get(scopeId);

  // 查询 lanes 数据
  const lanes = db.prepare(`
    SELECT lane, status, COUNT(*) as count
    FROM file_index_lanes
    WHERE scope_id = ?
    GROUP BY lane, status
  `).all(scopeId);

  return { ...scopeRow, lanes, failedCount: /* 统计失败数 */ 0 };
});
```

> **数据来源**: Electron 后端使用 `better-sqlite3` (db.ts) 存储知识库向量（`knowledge_vectors` 表）。`IndexManager` 类通过 `getStatus()` 提供实时队列状态，`getVectorStats()` 提供全局向量统计。与 Tauri 版 Tantivy 全文索引不同，Electron 版需从 SQLite 查询聚合数据。

#### 辅助函数: `buildLanesFromStatus`

```typescript
function buildLanesFromStatus(
  status: ReturnType<typeof indexManager.getStatus>,
  stats: ReturnType<typeof getVectorStats>
): FileIndexLaneStatus[] {
  return [
    {
      lane: 'active', label: '处理中',
      status: status.activeItems.length > 0 ? 'running' : 'idle',
      done: 0, total: status.activeItems.length, failed: 0,
      metadataOnly: 0, lastUpdatedAt: null, nextRetryAt: null
    },
    {
      lane: 'queue', label: '队列',
      status: status.totalQueueLength > 0 ? 'running' : 'idle',
      done: status.processedCount,
      total: status.totalQueueLength + status.processedCount,
      failed: 0, metadataOnly: 0,
      lastUpdatedAt: null, nextRetryAt: null
    },
    {
      lane: 'vectors', label: '向量存储',
      status: 'idle',
      done: stats.totalVectors, total: stats.totalVectors,
      failed: 0, metadataOnly: 0,
      lastUpdatedAt: null, nextRetryAt: null
    }
  ];
}
```

### 5.2 设置存储需新增字段

在 settings store 中新增 22 个字段 (见 2.1-B)，映射约定:
- `visual_index_enabled` → 布尔
- `visual_index_*` → 字符串/数字/布尔
- `docling_endpoint`, `tika_endpoint`, `unstructured_endpoint` → 字符串
- `parser_api_key` → 字符串 (敏感，建议加密存储)
- `parser_max_file_size` → 字符串 (如 "100MB")
- `parser_timeout_seconds` → 数字
- `rerank_*` → 字符串/数字

### 5.3 preload.ts 通道暴露方案

Electron 使用 `contextBridge` 暴露 IPC 通道。当前 `preload.ts` 提供通用的 `invoke(channel, payload?)` 接口，前端通过 `bridge/ipcRenderer.ts` 封装调用。

**无需修改 `preload.ts`**：当前 preload.ts 的通用 invoke 接口已支持任意通道名：

```typescript
// preload.ts L45-46 (现有代码)
contextBridge.exposeInMainWorld('__RED_ELECTRON_IPC__', {
  invoke(channel: string, payload?: unknown) {
    return ipcRenderer.invoke(channel, payload);
  },
  // ...
});
```

**需在 `bridge/ipcRenderer.ts` 中新增封装**：

```typescript
// bridge/ipcRenderer.ts knowledge 命名空间下新增:
knowledge: {
  // ... 现有通道 ...
  getFileIndexDashboard: async <T = FileIndexDashboard>() => {
    return invokeCommand('knowledge_get_file_index_dashboard') as Promise<T>;
  },
  getFileIndexScopeStatus: async <T = FileIndexScopeStatus>(scopeId: string) => {
    return invokeCommand('knowledge_get_file_index_scope_status', { scopeId }) as Promise<T>;
  },
}
```

### 5.4 DB Schema 迁移方案

Electron 版使用 `better-sqlite3`，需新增/确认以下表结构：

```sql
-- 新增: 文件索引进度追踪表 (如不存在)
CREATE TABLE IF NOT EXISTS file_index_lanes (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  status TEXT DEFAULT 'idle',
  done INTEGER DEFAULT 0,
  total INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  metadata_only INTEGER DEFAULT 0,
  last_updated_at TEXT,
  next_retry_at TEXT,
  FOREIGN KEY (scope_id) REFERENCES scopes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_index_lanes_scope
  ON file_index_lanes(scope_id);

-- 新增: 索引操作日志 (用于失败追踪)
CREATE TABLE IF NOT EXISTS file_index_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- 'indexed' | 'failed' | 'skipped' | 'removed'
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_index_events_source
  ON file_index_events(source_id);
CREATE INDEX IF NOT EXISTS idx_file_index_events_type
  ON file_index_events(event_type);

-- 迁移数据: 从 knowledge_vectors 表统计现有索引
INSERT OR IGNORE INTO file_index_lanes (id, scope_id, lane, status, done, total)
SELECT
  v.source_id as id,
  COALESCE(json_extract(v.metadata, '$.scopeId'), 'unknown') as scope_id,
  'vectors' as lane,
  'idle' as status,
  COUNT(*) as done,
  COUNT(*) as total
FROM knowledge_vectors v
GROUP BY v.source_id;
```

> **迁移策略**: 
> 1. 在 `db.ts` 的 schema 初始化函数中添加 `CREATE TABLE IF NOT EXISTS` 语句（幂等迁移）
> 2. 首次启动时从现有 `knowledge_vectors` 表填充 lane 统计
> 3. 后续由 `IndexManager.reindexItem()` 在执行时更新 lane 计数
> 4. 不需要单独的迁移文件，利用 SQLite 的 `IF NOT EXISTS` 保证幂等

### 5.5 后端可选增强

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 索引进度上报 (events) | P2 | 活跃索引任务时推送进度事件 |
| 索引完成通知 | P2 | 索引进度 100% 时推送通知 |
| 视觉索引健康检查 | P2 | 检查视觉索引端点可用性 |

---

## 六、CSS 样式差异

SettingsSections.tsx 新增样式 (Tailwind classes, 无需额外 CSS 文件):

| 组件 | 关键 class |
|------|-----------|
| FileIndexStatusBadge | `inline-flex h-5 rounded-full border px-2 text-[11px] font-medium` + 彩色状态 variant |
| FileIndexProgressText | `text-right font-mono text-[11px] text-text-tertiary` |
| FileIndexSettingsPanel | `rounded-lg border border-border bg-surface-secondary/30 p-4` |
| Lanes 表格 | `grid grid-cols-[minmax(0,1fr)_80px_120px]` |
| Scopes 表格 | `grid grid-cols-[minmax(0,1fr)_56px_54px_84px]` |
| Experimental 折叠面板 | `rounded-lg border border-border bg-surface-secondary/30` + `border-accent-primary/30` 展开态 |
| 解析服务网格 | `grid gap-3 md:grid-cols-3` |
| 重排服务网格 | `grid gap-3 md:grid-cols-2` |

**均为 Tailwind 原子类，无新增 CSS 文件。**

---

## 七、分步执行计划

### Step 1: 类型定义 (0.5 天)

**目标文件**: `src/pages/settings/SettingsSections.tsx`

- [ ] 添加 `FileIndexLaneStatus` type
- [ ] 添加 `FileIndexScopeStatus` type  
- [ ] 添加 `FileIndexDashboard` type
- [ ] 在 `SettingsFormData` 中添加 20 个新字段 (visual_index_*, docling_*, tika_*, unstructured_*, parser_*, rerank_*)
- [ ] TypeScript 编译验证

**可独立提交**: ✅ (仅类型，无运行时影响)

### Step 2: FileIndexDashboard 组件 (1 天)

**目标文件**: `src/pages/settings/SettingsSections.tsx`

- [ ] 实现 `fileIndexStatusLabel()` 辅助函数
- [ ] 实现 `fileIndexScopeLabel()` 辅助函数
- [ ] 实现 `fileIndexStatusClass()` 辅助函数
- [ ] 实现 `FileIndexStatusBadge` 组件
- [ ] 实现 `FileIndexProgressText` 组件
- [ ] 实现 `FileIndexSettingsPanel` 组件 (含 lanes + scopes 表格)
- [ ] 在 `GeneralSettingsSectionInner` props 中添加 `fileIndexDashboard`/`fileIndexLoading`/`handleRefreshFileIndexDashboard`
- [ ] 在 `GeneralSettingsSectionInner` JSX 中渲染 `<FileIndexSettingsPanel>`

**可独立提交**: ✅ (传入 null dashboard 时显示空状态)

### Step 3: 后端 IPC 通道 (0.5 天)

**目标文件**: Electron 主进程

- [ ] 实现 `knowledge:get-file-index-dashboard` IPC handler
- [ ] 返回 `FileIndexDashboard` 结构 (可从空实现开始)
- [ ] 更新 `types.d.ts` 中 `getFileIndexDashboard` 声明 (如已存在则确认)
- [ ] 扩展 `knowledge:rebuild-catalog` 支持 `includeVisualIndex` 参数

**可独立提交**: ✅

### Step 4: Settings.tsx 集成 FileIndexDashboard (0.5 天)

**目标文件**: `src/pages/Settings.tsx`

- [ ] 导入 `FileIndexDashboard` type
- [ ] 实现 `FileIndexDashboardCacheRecord` type
- [ ] 实现 `readCachedFileIndexDashboard` / `writeCachedFileIndexDashboard` / `clearCachedFileIndexDashboard`
- [ ] 添加 `fileIndexDashboard` state
- [ ] 添加 `isFileIndexDashboardLoading` state
- [ ] 实现 `isEmptyFileIndexDashboardFallback` 
- [ ] 实现 `loadFileIndexDashboard` (含缓存逻辑)
- [ ] 在 `GeneralSettingsSection` 调用处传递 `fileIndexLoading` 和 `handleRefreshFileIndexDashboard`

> ⚠️ **同文件冲突避免**: Step 4 与 Step 5 均修改 `Settings.tsx`。协调策略：
> 1. Step 4 的修改集中在文件**上半部分**（imports、state、缓存逻辑、loadFileIndexDashboard）
> 2. Step 5 的修改集中在文件**下半部分**（formData 默认值、loadBaseSettings、saveSettings、tab 渲染分支）
> 3. **执行顺序**: Step 4 先提交 → Step 5 基于 Step 4 的提交 rebase 后再修改
> 4. **关键冲突点**: `preserveLocalFormState` 数组在 Step 4 不修改，由 Step 5 添加 `'experimental'`

**可独立提交**: ✅

### Step 5: ExperimentalSettingsSection 组件 (0.5 天)

**目标文件**: `src/pages/settings/SettingsSections.tsx`

- [ ] 实现 `ExperimentalSettingsSectionInner` 组件 (解析服务 + 重排服务表单)
- [ ] 导出 `ExperimentalSettingsSection = memo(ExperimentalSettingsSectionInner)`

**目标文件**: `src/pages/Settings.tsx`

- [ ] 导入 `ExperimentalSettingsSection`
- [ ] 在 formData 默认值中添加 22 个新字段的默认值
- [ ] 在 `loadBaseSettings` 中添加新字段的读取逻辑
- [ ] 在 `saveSettings` 中添加新字段的保存/校验逻辑
- [ ] 添加 `activeTab === 'experimental'` 渲染分支
- [ ] 在 `preserveLocalFormState` 中加入 `'experimental'`

> ⚠️ **同文件冲突避免**: Step 5 依赖 Step 4 的 imports 和缓存逻辑。必须基于 Step 4 的提交进行修改。Step 5 中 Settings.tsx 的修改集中在设置持久化逻辑（loadBaseSettings/saveSettings/formData），与 Step 4 的文件索引仪表盘逻辑（缓存/加载/刷新）在文件中物理隔离。
>
> Step 5 同样修改 `SettingsSections.tsx`，与 Step 1（类型定义）和 Step 2（FileIndexSettingsPanel）冲突。执行顺序：Step 1 → Step 2 → Step 5，Step 5 的 ExperimentalSettingsSectionInner 在文件尾部（L978+），与 Step 2 的 FileIndexSettingsPanel（L468-561）不重叠。

**可独立提交**: ✅ (但需要 Step 1 的类型定义，Step 4 的 Settings.tsx 基础)

### Step 6: 视觉索引模型选择逻辑 (0.5 天)

**目标文件**: `src/pages/Settings.tsx`

- [ ] 实现 `filterVisualIndexModels` 
- [ ] 实现 `pickBestVisualIndexModelForSource`
- [ ] 添加 `visualIndexSourceId` state
- [ ] 添加 `selectedVisualIndexSource` useMemo
- [ ] 添加 `visualIndexSourceModels` useMemo
- [ ] 在设置表单中渲染视觉索引模型选择器 (复用 AI Source 选择器)
- [ ] 渲染视觉索引的所有配置字段 (超时/并发/图片尺寸/PDF参数/SkipSmallImages)
- [ ] 实现 `normalizeVisualIndexPromptVersion`

**可独立提交**: ✅

### Step 7: 连通测试 + 样式微调 (0.5 天)

- [ ] 开启 settings 页面 → 确认 'experimental' tab 出现
- [ ] 切换到 General tab → 确认 FileIndexDashboard 加载
- [ ] 点击刷新 → 确认 dashboard 数据更新
- [ ] 切换到实验功能 tab → 确认解析配置面板可展开
- [ ] 填写并保存视觉索引配置
- [ ] 填写并保存文档解析配置
- [ ] 填写并保存重排配置
- [ ] 切换 tab 再切回 → 确认表单状态保持
- [ ] 确认 localStorage 缓存正常工作

---

## 八、预计工作量

| 步骤 | 内容 | 工时 | 可独立提交 |
|------|------|------|-----------|
| Step 1 | 类型定义 | 0.5 天 | ✅ |
| Step 2 | FileIndexDashboard 组件 | 1 天 | ✅ |
| Step 3 | 后端 IPC 通道 | 0.5 天 | ✅ |
| Step 4 | Settings.tsx 集成 Dashboard | 0.5 天 | ✅ |
| Step 5 | ExperimentalSettingsSection | 0.5 天 | ✅ |
| Step 6 | 视觉索引模型选择逻辑 | 0.5 天 | ✅ |
| Step 7 | 连通测试 + 样式微调 | 0.5 天 | ✅ |
| **总计** | | **3-5 天** | |

---

## 九、风险与注意事项

1. **localStorage 键名冲突**: 确保 `readCachedFileIndexDashboard`/`writeCachedFileIndexDashboard` 使用的键名不与现有代码冲突
2. **AI Source 下拉联动**: 视觉索引模型选择器依赖 `getAiSourceById` / `getSourceModelList`，需确认这两个函数在新版中已可用
3. **PasswordInput 组件**: 需要 `settings/shared.tsx` 中已导出 `PasswordInput`，旧版中需确认或自行实现
4. **Tantivy 索引状态**: Electron 后端可能没有 Tantivy，需要通过不同方式获取文件索引状态。建议先返回 mock dashboard 数据让 UI 通路，再替换为实际索引查询
5. **设置字段兼容性**: 保存新字段时注意旧版设置文件的兼容性，新字段缺失时应使用默认值
