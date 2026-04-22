# LexBox IPC 优化方案

更新时间：2026-04-18

## 目标

这份方案解决两个问题：

1. 页面切换、初始化、刷新时，不能因为单条 IPC 变慢或宿主锁竞争而导致整个页面卡住。
2. 当前 IPC 已经有统一 bridge，但宿主仍然保留了较重的字符串总线分发；需要把它收敛成更符合 Tauri v2 的工程结构。

最终目标不是“换一种调用写法”，而是形成一套稳定架构：

- Renderer 侧统一：所有页面只通过 typed bridge 调用宿主。
- Host 侧分域：业务能力按 domain command 拆分，不继续扩大字符串总线。
- Runtime 侧集中：I/O、调度、索引、AI runtime、后台任务放到 service/runtime/store。
- 传输层分工清晰：
  - `command`：请求-响应
  - `event`：状态变化广播
  - `channel`：流式或高频有序数据

## 当前状态

### 现状判断

当前仓库已经是“桥统一 + 宿主半集中”的混合架构：

- Renderer 统一入口：
  - [src/bridge/ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/ipcRenderer.ts:1)
- Host 统一兼容入口：
  - [src-tauri/src/main.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/main.rs:6252)
- Host 业务已按域拆分：
  - [src-tauri/src/commands](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands)

这说明：

- 前端层面已经具备统一治理的基础。
- 宿主层面已经具备按业务域拆分的基础。
- 真正的问题不在“有没有分模块”，而在“兼容总线仍然承担了太多主路径责任”。

### 当前主要风险

1. `ipc_invoke(channel, payload)` 仍是宿主主入口，新增能力继续往这条总线上堆，`main.rs` 会持续膨胀。
2. 部分 page-facing IPC 仍然存在：
   - 宿主慢调用
   - 锁内文件 I/O
   - 首屏直接 await IPC
   - 页面把“首次显示”绑定到 IPC 成功
3. `event` 和 `command` 的边界还不够清晰，流式链路未来容易继续混用。
4. payload fallback 还主要靠 bridge 的兼容逻辑，typed contract 还不够强。

## 最终推荐架构

### 1. Renderer：统一 typed bridge

保留 [src/bridge/ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/ipcRenderer.ts:1)，但它的职责必须稳定在以下范围：

- 暴露 typed domain API
- 统一 timeout / fallback / normalize
- 统一 diagnostics / slow IPC 标记
- 统一 late-result ignore 策略的工具能力

页面禁止：

- 直接写裸 `invoke('channel:string')`
- 自己拼 fallback shape
- 自己定义跨页面不一致的 timeout 策略

建议固定 domain 结构：

```ts
window.ipcRenderer.spaces.*
window.ipcRenderer.knowledge.*
window.ipcRenderer.advisors.*
window.ipcRenderer.redclaw.*
window.ipcRenderer.sessions.*
window.ipcRenderer.runtime.*
window.ipcRenderer.system.*
```

### 2. Host：显式 domain commands，兼容总线降级

保留：

- `ipc_invoke`
- `ipc_send`

但它们只作为：

- 旧页面兼容层
- 迁移过渡层
- diagnostics / interception 辅助入口

新增能力默认不要再走：

```rust
ipc_invoke(channel, payload) -> main.rs giant match -> commands/*
```

而是走显式命令：

```rust
#[tauri::command]
async fn spaces_list(...)

#[tauri::command]
async fn redclaw_runner_status(...)

#[tauri::command]
async fn advisors_list(...)
```

命令所在文件继续按 domain 组织，例如：

- [src-tauri/src/commands/spaces.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/spaces.rs:1)
- [src-tauri/src/commands/redclaw.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/redclaw.rs:1)
- [src-tauri/src/commands/advisor_ops.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/advisor_ops.rs:1)
- [src-tauri/src/commands/workspace_data.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/workspace_data.rs:1)

### 3. Service / runtime：业务集中，不进 command

command 只做四件事：

1. 解析 payload
2. 校验输入
3. 调用 service/runtime/persistence
4. 组装返回值

不要在 command 里做：

- 大段业务编排
- 目录扫描
- transcript/index 读取
- workspace hydration
- 大 JSON 构造
- 长时间锁竞争

真正的实现层继续放在：

- `persistence/*`
- `workspace_loaders.rs`
- `runtime/*`
- `session_manager.rs`
- `scheduler/*`
- `events/*`

### 4. IPC primitive 边界

固定边界如下：

#### command

用于：

- 列表查询
- 详情查询
- 用户触发动作
- 配置保存
- 低频状态读取

不用于：

- 高频流式消息
- 大体积持续推送

#### event

用于：

- 状态已变化通知
- 后台任务状态变化
- 空间切换
- runner 状态广播

不用于：

- 大 payload
- 有序增量流
- 长 transcript 输出

#### channel

用于：

- AI 流式输出
- 工具调用实时进度
- 高频 ordered progress
- sidecar/stdout/WebSocket 类连续消息

不用于：

- 一次性普通查询

## Tauri v2 对应实践

这套方案和 Tauri v2 官方建议一致：

- async command 优先，避免主线程阻塞：
  - [Calling Rust from the Frontend](https://v2.tauri.app/es/develop/calling-rust/)
- 全局状态用 `Manager` / `State` 管：
  - [State Management](https://v2.tauri.app/develop/state-management/)
- event 只做简单状态消息，流式更适合 channel：
  - [Calling the Frontend from Rust](https://v2.tauri.app/develop/calling-frontend/)
- 可复用原生能力优先抽 plugin：
  - [Plugin Development](https://v2.tauri.app/develop/plugins/)

## 明确的优化策略

### A. 页面入口 IPC 保护层

这是已经开始落地的第一层：

- bridge 统一 `invokeGuarded`
- 支持 `timeoutMs`
- 支持 `fallback`
- 支持 `normalize`
- 页面只在首次空状态展示整页 loading
- 已有快照时走 stale-while-revalidate

适用范围：

- `RedClaw`
- `Knowledge`
- `Advisors`
- 后续扩展到 `Settings`、`Wander`、`session-bridge`

### B. page-facing IPC 白名单治理

把所有页面首屏依赖 IPC 列成白名单，逐条治理。

优先级最高的命令：

- `spaces:list`
- `skills:list`
- `knowledge:list`
- `knowledge:list-youtube`
- `knowledge:docs:list`
- `advisors:list`
- `chat:list-context-sessions`
- `redclaw:runner-status`
- `sessions:list`
- `sessions:get`
- `sessions:resume`

对这些命令执行统一规则：

- 必须 async
- 必须可超时
- 首次 payload 只返回 summary
- 不允许锁内 I/O
- 超过 50ms 进入 slow audit
- 超过 200ms 必须解释原因或拆分

### C. `main.rs` 瘦身

目标：让 [src-tauri/src/main.rs](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/main.rs:1) 只保留：

- `manage(...)`
- plugin setup
- event setup
- invoke handler registration
- app bootstrap

不再承担：

- 大量 channel 分发逻辑
- 复杂业务装配
- 领域级行为判断

### D. 从字符串总线迁到显式命令

迁移规则：

1. 新增能力只新增显式 command，不新增新的 `channel` 字符串分支。
2. 已稳定且高频的 page-facing IPC 优先迁移。
3. 低风险、低频、纯兼容入口保留在总线层。

优先迁移域：

- `spaces`
- `knowledge`
- `advisors`
- `redclaw status/config`
- `sessions`

暂时保留总线的域：

- 旧 chat 兼容链路
- 过渡期 runtime 复合入口
- 少量历史兼容页面

### E. event/channel 重新分边界

优化目标：

- `chat` / `runtime` 的流式输出逐步从 event 混用收敛到 channel
- event 保留给“状态变化已发生”
- 任何会持续发多段消息的链路，都优先评估是否改成 channel

## 模块实现建议

### Renderer

保留并加强：

- [src/bridge/ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/bridge/ipcRenderer.ts:1)

新增约束：

- 每个 domain 都有明确 API 段
- 每个 API 都有 normalize
- 页面只消费 normalized shape
- bridge 负责 diagnostics 埋点

推荐结构：

```ts
spaces: {
  list(): Promise<SpaceListPayload>
  switch(spaceId: string): Promise<SwitchResult>
}

knowledge: {
  listNotes(): Promise<Note[]>
  listYoutube(): Promise<YouTubeVideo[]>
  listDocs(): Promise<DocumentKnowledgeSource[]>
}
```

### Host command layer

推荐每个域的文件同时提供两套入口：

1. 显式 command
2. 兼容总线 adapter

示意：

```rust
#[tauri::command]
async fn spaces_list(app: AppHandle, state: State<'_, AppState>) -> Result<SpaceListPayload, String> {
    spaces_service::list(&app, &state).await
}

pub fn handle_spaces_channel(...) -> Option<Result<Value, String>> {
    match channel {
        "spaces:list" => Some(serialize(spaces_service::list_sync_adapter(...))),
        _ => None,
    }
}
```

这样可以做到：

- 新代码走显式 command
- 旧代码继续兼容
- 业务实现不重复

### Runtime / persistence

继续强化已有分层：

- `persistence`：文件与 store
- `workspace_loaders`：工作区装载
- `runtime`：AI runtime / transcript / tool results
- `events`：统一广播出口

不要把这些职责重新拉回 command。

## 必须用现成库 vs 应该自研

### 必须用现成能力

- Tauri v2 command / event / channel 原语
- `State` / `Manager` 状态机制
- plugin 机制用于未来可复用原生能力

这些是框架原生能力，不应该自造一套新的 IPC 系统覆盖它们。

### 应该自研

- typed bridge
- fallback / normalize 策略
- page-facing timeout policy
- slow IPC diagnostics
- 兼容总线到显式 command 的迁移层
- domain service 边界

## 性能优化策略

### 1. 宿主侧

- page-facing command 一律 async
- CPU 重活放 `spawn_blocking`
- I/O 尽量 async 或锁外执行
- payload summary-first，详情 lazy fetch
- 严禁持锁做：
  - transcript/index 读取
  - workspace hydration
  - 目录扫描
  - 大序列化

### 2. 前端侧

- render first, hydrate later
- 有旧数据时不整页 loading
- late result ignore
- stale-while-revalidate
- 对列表和 transcript 做分页/虚拟化/增量加载

### 3. 调试与观测

在 diagnostics 中增加：

- 最慢 page-facing IPC
- timeout 次数
- fallback 次数
- payload 大小分布
- 页面首屏关键命令耗时

## 迁移顺序

### 第一批

- `spaces:list`
- `skills:list`
- `advisors:list`
- `knowledge:list*`
- `redclaw:runner-status`
- `chat:list-context-sessions`

原因：这些是多个页面的首屏依赖，收益最大。

### 第二批

- `sessions:list/get/resume`
- `session-bridge:*`
- `runtime:get-trace/get-tool-results/get-checkpoints`

### 第三批

- 剩余低频后台管理命令
- 总线兼容入口清理

## 验收标准

### 架构验收

- 新增页面能力不再要求往 `main.rs` 的总线分发里加字符串分支
- 页面不再直接写裸 `invoke('channel')`
- event / channel / command 的边界在代码和文档中一致

### 体验验收

- 页面切换不因单条 IPC 卡住而阻塞首次显示
- 有旧快照时刷新失败不清空页面
- 高频页面初始化不再依赖锁内 I/O

### 可维护性验收

- 新人只看 bridge + command 规范文档就能新增一个 domain API
- `main.rs` 不再继续增长为业务总路由中心

## 最终推荐

对 LexBox，最优解不是：

- 全继续维持字符串总线
- 或者让每个页面自己分散直接调 Tauri invoke

而是：

**统一前端 bridge，分域宿主 commands，集中 service/runtime，明确区分 command / event / channel。**

这也是当前仓库成本最低、回归风险最低、同时又最符合 Tauri v2 工程实践的路线。
