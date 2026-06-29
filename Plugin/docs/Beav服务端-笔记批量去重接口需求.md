# Beav 服务端 — 笔记批量去重检查接口

## 背景

浏览器插件（小红书采集）当前使用 `chrome.storage.local` 做本地缓存来跳过已采集笔记。但这有两个问题：

1. **卸载插件 = 缓存丢失**，重装后之前采集过的笔记无法跳过
2. **单条保存和批量采集不同步**，通过"保存当前笔记"入库的笔记，批量采集时不知道

最优方案：插件直接查 Beav 本地数据库，问"这些笔记哪些已存在"。

## 插件端使用场景

### 场景 A：API 模式批量采集（已集成）
采集前对**当前页面所有笔记 ID** 调用本接口，与本地缓存合并后统一去重：
- 已存在的 → 跳过，不拉取小红书内容，不提交
- 不存在的 → 进入采集循环

### 场景 B：单条"保存当前笔记"（可扩展）
理论上也可以在运行内容脚本提取之前先调用本接口（传入单个 noteId）：
- 已存在 → 直接返回"重复内容已跳过"，不拉取内容
- 不存在 → 正常提取并提交

当前版本已通过 `markCollectedXhsNotesForBlogger` 将单条保存的 noteId 同步到本地缓存，作为过渡方案。

## 接口设计

### `POST /api/knowledge/entries/check`

**描述：** 批量检查一组外部 ID 是否已存在于知识库。

**请求：**

```
POST /api/knowledge/entries/check
Content-Type: application/json

{
  "externalIds": [
    "68173abf000000002102df77",
    "6810dd9800000000210006d8",
    "6a40ad5800000000060318b4"
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `externalIds` | `string[]` | ✅ | 小红书 noteId 列表，去重后最多 500 条 |

**成功响应：**

```json
{
  "success": true,
  "data": {
    "exists": ["68173abf000000002102df77"],
    "missing": ["6810dd9800000000210006d8", "6a40ad5800000000060318b4"]
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `data.exists` | `string[]` | 已存在于知识库的 externalId |
| `data.missing` | `string[]` | 不存在于知识库的 externalId |

**失败响应：**

```json
{
  "success": false,
  "error": "参数 externalIds 不能为空"
}
```

## 实现要点

1. **查询逻辑：** 对每个 `externalId`，查知识库 entries 表中 `sourceExternalId` 字段（即 `source.externalId`）是否已存在
2. **性能：** 单次查询，用 `WHERE sourceExternalId IN (...)` 一条 SQL 完成
3. **上限：** externalIds 最多 500 条，超出返回 400 错误
4. **幂等：** 多次调用相同参数返回相同结果
5. **去重：** 即使请求中有重复 ID，响应中 `exists` 和 `missing` 各自去重

## 验收标准

- [ ] 请求空数组 `{ "externalIds": [] }` → `{ "success": true, "data": { "exists": [], "missing": [] } }`
- [ ] 请求不存在的 ID → 全部在 `missing` 中
- [ ] 请求已入库的 ID → 全部在 `exists` 中
- [ ] 请求超出 500 条 → `{ "success": false, "error": "参数 externalIds 超过上限 500" }`
- [ ] 服务不可用时，插件采集流程不受影响（已有容错降级）
