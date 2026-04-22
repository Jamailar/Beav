# IPC 管理规范

更新时间：2026-04-18

本文件约束 `src-tauri/src/commands/` 目录及其对应的 renderer bridge 调用方式。目标是让新增命令、迁移旧命令、页面加载优化都遵守同一套规则。

## 适用范围

- Host command 模块：
  - [src-tauri/src/commands](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src-tauri/src/commands)
- Host 兼容入口：
  - [src-tauri/src/main.rs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src-tauri/src/main.rs:6252)
- Renderer bridge：
  - [src/bridge/ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src/bridge/ipcRenderer.ts:1)

## 一、总体原则

### 1. 前端统一，宿主分域

允许统一的只有 renderer bridge。

不允许把所有业务继续统一到一个巨型字符串总线里。

正确结构：

- 页面 -> `window.ipcRenderer.<domain>.<method>()`
- host -> `commands/<domain>.rs`
- service/runtime/persistence -> 真正业务实现

### 2. `main.rs` 是装配层，不是业务路由中心

[src-tauri/src/main.rs](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src-tauri/src/main.rs:1) 只应该承担：

- app setup
- state manage
- plugin setup
- invoke handler registration
- 启动恢复逻辑

禁止继续把领域逻辑堆进 `main.rs`。

### 3. 新功能默认不要再扩字符串总线

现有：

- `ipc_invoke`
- `ipc_send`

是兼容层，不是未来主架构。

规则：

- 新增能力优先使用显式 `#[tauri::command]`
- 旧页面兼容可以继续走总线
- 迁移时由 bridge 决定调用哪条宿主入口

## 二、command / event / channel 的边界

### command

用于：

- 查询列表
- 查询详情
- 用户点击触发的动作
- 保存配置
- 低频状态获取

要求：

- 返回值必须可序列化
- payload 必须小而稳定
- page-facing command 默认 async

### event

用于：

- 状态已经变化的通知
- 后台任务状态变化
- 空间切换
- runner 状态刷新

禁止：

- 大数据包
- 高频流式文本
- transcript 全量传输

### channel

用于：

- AI 流式输出
- 工具执行进度
- 高频 ordered message
- child process/stdout 类连续数据

不用于普通查询。

## 三、页面首屏 IPC 规则

所有 page-facing IPC 必须满足以下要求：

1. 首屏只返回 summary，不返回全量细节
2. 必须允许 renderer 设置 timeout
3. 必须允许 renderer fallback 到安全默认值
4. 不允许让页面首次显示依赖全部 IPC 完成
5. 首屏命令执行时间超过 50ms 必须进入 slow audit

高优先级 page-facing 命令包括：

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

## 四、宿主命令实现规则

### 1. page-facing command 默认 async

如果命令可能触发以下任一行为，就必须 async：

- 文件 I/O
- transcript/index 读取
- SQLite 查询
- 目录扫描
- 大 JSON 构造
- 媒体探测
- 网络访问

### 2. CPU 重任务用 `spawn_blocking`

适用于：

- 大序列化
- 文本切分
- 索引构建
- 密集计算

### 3. 锁内只取快照，不做慢事

固定模式：

1. 锁内读取最小状态快照
2. 释放锁
3. 锁外做 I/O / hydration / index 读取
4. 锁内只做最终内存回写

禁止：

- 持锁读 transcript 文件
- 持锁扫 workspace
- 持锁读取目录
- 持锁做大 JSON 组装
- 持锁等待其他任务

### 4. command 只做边界，不做重业务

command 内允许：

- payload parse
- input validate
- 调 service
- serialize result

command 内不允许：

- 写大段业务编排
- 直接实现跨模块复杂逻辑
- 页面私有行为判断

## 五、renderer bridge 规则

bridge 文件：

- [src/bridge/ipcRenderer.ts](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src/bridge/ipcRenderer.ts:1)

bridge 必须负责：

- typed API facade
- timeout
- fallback
- normalize
- 兼容旧宿主入口

页面禁止：

- 直接使用裸 channel string
- 自己拼 fallback response
- 自己决定不同页面的相同命令返回 shape

推荐写法：

```ts
knowledge: {
  listNotes: () =>
    invokeGuarded<Note[]>('knowledge:list', undefined, {
      timeoutMs: 3200,
      fallback: [],
      normalize: (value) => Array.isArray(value) ? value as Note[] : [],
    })
}
```

## 六、返回值规范

### 1. 首选 typed object，不返回“半结构化 JSON”

推荐：

```json
{
  "items": [],
  "cursor": null,
  "total": 0
}
```

不推荐：

```json
{
  "ok": true,
  "data": { "...": "..." },
  "metaMaybe": null
}
```

### 2. fallback shape 必须稳定

例如：

- `spaces:list` -> `{ activeSpaceId, spaces }`
- `knowledge:list` -> `[]`
- `redclaw:runner-status` -> `null` 或稳定 status object

不要让页面自己猜宿主失败后应该收到什么。

### 3. 首屏 payload 必须小

禁止页面首屏直接返回：

- 全量 transcript
- 全量项目树
- 大量 base64
- 完整文档正文

首屏只给：

- id
- title
- updatedAt
- count
- preview
- status

详情 lazy fetch。

## 七、事件规范

所有 host -> renderer 事件必须通过统一事件出口组织，优先走：

- [src-tauri/src/events](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src-tauri/src/events)

不要在随机 command handler 里手写大量散乱 emit 逻辑。

事件命名规则：

- 领域前缀明确
- 表示“已发生状态变化”

例如：

- `space:changed`
- `redclaw:runner-status`
- `chat:session-title-updated`

## 八、何时应抽成 plugin

当能力满足以下任一条件时，优先评估 plugin：

- 明显属于平台能力
- 可能在其他 app 或其他子系统复用
- 需要独立权限边界
- 需要独立 JS API 绑定

当前更像 app 内 domain command 的，不要过早 plugin 化。

## 九、迁移规则

### 新能力

- 直接写显式 command
- bridge 提供 typed API
- 页面只用 typed bridge

### 旧能力

- 保留原 channel 兼容
- 在 domain 内新增共享 service 实现
- bridge 逐步切换到新入口
- 最终下线旧 channel 分支

### 优先迁移对象

- 高频 page-facing IPC
- 首屏依赖 IPC
- 已经出现卡顿/锁争用问题的命令

## 十、代码审查清单

新增或修改 IPC 时，必须逐项检查：

1. 这是 command、event 还是 channel？边界选对了吗？
2. 页面是否通过 bridge 调用，而不是裸 invoke？
3. 这是 page-facing 命令吗？如果是，是否 async？
4. 是否在锁内做了 I/O、扫描或大序列化？
5. 返回 shape 是否稳定、可 fallback？
6. 首屏 payload 是否过大？
7. 页面是否能在超时/失败时保留旧数据？
8. 是否真的需要加到兼容总线，而不是显式 command？

## 十一、当前仓库的明确执行策略

当前项目采用以下策略：

- 保留 `ipc_invoke` / `ipc_send` 作为兼容层
- 新增高价值页面能力优先迁到显式 command
- renderer bridge 统一治理 timeout/fallback/normalize
- 页面默认使用 stale-while-revalidate
- 宿主严格执行“锁内快照、锁外 I/O”

## 十二、相关文档

- [commands/README.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/src-tauri/src/commands/README.md)
- [docs/ipc-inventory.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/docs/ipc-inventory.md)
- [docs/ipc-optimization-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/LexBox/docs/ipc-optimization-plan.md)
