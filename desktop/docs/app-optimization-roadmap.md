---
doc_type: plan
execution_status: in_progress
last_updated: 2026-04-25
owner: product-engineering
scope: desktop
source_of_truth: true
success_metrics:
  - 关键页面切换保持 shell first，不因刷新清空已有数据
  - AI runtime 首轮响应、工具执行、恢复链路稳定且可观测
  - 视频编辑与导出链路可稳定支撑长稿件与大素材
  - 所有优化任务都有状态、进度、验证证据和收尾要求
related_docs:
  - desktop/docs/architecture/system-overview.md
  - desktop/docs/architecture/product-module-breakdown.md
  - desktop/docs/ai-runtime-maintenance-overview.md
  - desktop/docs/ipc-inventory.md
  - desktop/docs/runtime-optimization-test-plan.md
---

# RedBox App Overall Optimization Roadmap

Status: Current

## Scope

这份文档是 `desktop/` 主产品的长期优化总表，用来统一管理：

1. 当前产品架构基线
2. 各工作流的优化目标和执行顺序
3. 每项任务的状态、进度、验证方式、收尾要求
4. 后续在本对话中提出的新需求如何回写到同一份文档

本文件不覆盖：

- `archive/desktop-electron/`
- `Plugin/` 的独立版本规划
- `RedBoxweb/` 的官网内容运营

## How To Use

以后你在这个对话里提出任何要做的事，我都按下面规则维护本文件：

1. 如果是新目标：新增任务卡，并挂到对应工作流。
2. 如果是已有目标推进：更新 `status`、`progress`、`last_update`、`evidence`。
3. 如果任务完成：把 `status` 改为 `done`，补齐 `cleanup` 和 `verification`。
4. 如果目标失效：把 `status` 改为 `cancelled`，说明原因，不直接删除记录。

状态枚举统一为：

| Status | 含义 |
| --- | --- |
| `planned` | 已确认值得做，但尚未开始 |
| `ready` | 依赖已满足，可直接执行 |
| `in_progress` | 正在执行 |
| `blocked` | 被依赖、资源或技术风险卡住 |
| `done` | 功能完成且通过验证 |
| `cancelled` | 不再执行，但保留决策记录 |

归档策略：

- `done` 任务会被归档到 `desktop/docs/archive/`（见 `completed-tasks-archive-YYYY-MM-DD.md`），主文档保留最小索引。
- 已标记为 `execution_status: completed` 且长期不再活跃的历史计划文档，放入 `completed-docs-archive-YYYY-MM-DD.md`。
- 当前版本已提交每周归档快照，命名格式 `completed-tasks-archive-YYYY-MM-DD.md` / `completed-docs-archive-YYYY-MM-DD.md`。
- 归档目标是保留完成任务的证据、验收、cleanup、risk 和下步动作。

归档入口：

- [completed-tasks-archive-2026-04-23.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/archive/completed-tasks-archive-2026-04-23.md)
- [completed-docs-archive-2026-04-23.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/archive/completed-docs-archive-2026-04-23.md)

优先级统一为：

| Priority | 含义 |
| --- | --- |
| `P0` | 直接影响稳定性、性能基线、AI 可控性、核心创作链路 |
| `P1` | 直接影响主流程效率和体验，但可短期绕过 |
| `P2` | 提升可维护性、扩展性、运营效率 |

## Architecture Baseline

### Layer Map

| Layer | Main Paths | Current Responsibility | 必须用现成库 | 必须自研 |
| --- | --- | --- | --- | --- |
| App Shell / UI | `desktop/src/App.tsx`, `desktop/src/components/*`, `desktop/src/pages/*` | 导航、页面容器、对话框、跨页消息、首屏呈现 | React、Suspense、Lucide、局部 UI 组件库 | 页面缓存策略、stale-while-revalidate、跨页状态传递 |
| IPC Bridge | `desktop/src/bridge/ipcRenderer.ts`, `desktop/src/runtime/runtimeEventStream.ts` | channel 封装、事件归一化、超时 fallback、兼容层 | Tauri API | typed bridge、兼容事件收敛、调用熔断 |
| Host Command Surface | `desktop/src-tauri/src/main.rs`, `desktop/src-tauri/src/commands/*` | renderer 请求装配、业务域路由、状态读取 | Tauri v2、serde | 命令域拆分、最小 payload、异步化装配 |
| AI Runtime | `desktop/src-tauri/src/runtime/*`, `desktop/src-tauri/src/agent/*`, `desktop/src-tauri/src/skills/*`, `desktop/src-tauri/src/tools/*`, `desktop/src-tauri/src/mcp/*`, `desktop/src-tauri/src/subagents/*` | 会话、任务、工具、技能、审批、MCP、子代理 | LLM transport、JSON schema、外部模型 API | runtime contract、context bundle、permission、tool policy、subagent orchestration |
| Persistence / Workspace | `desktop/src-tauri/src/persistence/*`, `desktop/src-tauri/src/workspace_loaders.rs` | store、workspace hydrate、快照恢复、文件落盘 | 文件系统、serde_json | schema、增量 hydration、锁外 I/O、快照瘦身 |
| Knowledge / Retrieval | `desktop/src-tauri/src/knowledge_index/*`, `desktop/src-tauri/src/document_ingest/*`, `desktop/src-tauri/src/commands/library.rs` | 文档摄取、切片、索引、召回、引用 | 嵌入模型、文件解析库、watcher | catalog、chunk policy、citation contract、重建调度 |
| Manuscripts / Video | `desktop/src/pages/Manuscripts.tsx`, `desktop/src/components/manuscripts/*`, `desktop/src/features/video-editor/*`, `desktop/src/remotion/*`, `desktop/src/vendor/freecut/*` | 稿件、时间线、字幕、转场、预览、导出 | Remotion、媒体探测库、浏览器媒体 API | 编辑协议、轨道状态、稿件到时间线映射、导出编排 |
| RedClaw / Automation | `desktop/src/pages/RedClaw.tsx`, `desktop/src/pages/Workboard.tsx`, `desktop/src-tauri/src/scheduler/*`, `desktop/src-tauri/src/commands/redclaw*.rs` | 自动化任务、长期调度、任务执行、结果回写 | 调度基础库、系统时间 API | 任务模型、执行状态机、可恢复作业、长期运行时 |
| Diagnostics / Ops | `desktop/src/pages/Settings.tsx`, `desktop/src/pages/settings/*`, `desktop/src-tauri/src/diagnostics.rs`, `desktop/src-tauri/src/logging/*` | 配置、调试、性能观测、错误恢复 | 日志库、系统 API | 运行时摘要、调试面板、回归证据收集 |

### Recommended Roadmap Structure

可选组织方式有三种：

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 按页面功能推进 | 用户感知快，便于短期演示 | 会把 IPC、runtime、持久化问题反复返工 | 不推荐作为主路线 |
| 按基础设施推进 | 架构更稳，回归面更小 | 短期用户体感提升慢 | 只能作为底层治理层 |
| 按“基础稳定 -> AI 内核 -> 创作链路 -> 自动化运营”推进 | 同时兼顾稳定性、主流程体验和后续扩展 | 需要严格控制依赖关系 | 推荐，作为本 roadmap 的执行主线 |

本 roadmap 采用第三种方案，顺序固定为：

1. 平台稳定层
2. AI 内核层
3. 创作生产层
4. 自动化与运营层

原因很直接：如果先做页面或新功能，当前 bridge、runtime、workspace、视频链路的结构性问题会不断回流，最后每个页面都要重改一次。

## Product Goals And KPIs

| Goal | KPI | Current Tracking Rule |
| --- | --- | --- |
| 页面切换稳定 | 切页不整页 loading，已有数据保留 | 真实页面切换验证 |
| AI 首轮响应速度 | 首字时间、工具调用耗时、完成率 | Settings diagnostics + 真实任务跑测 |
| 视频编辑可用性 | 大稿件打开时间、时间线操作卡顿、导出成功率 | 手工长稿验证 + 导出样本 |
| 检索可信度 | 召回命中率、引用质量、重建耗时 | 真实知识库样本验证 |
| 自动化可恢复性 | 调度漏跑率、重复执行率、失败恢复率 | RedClaw / Workboard 执行记录 |
| 可维护性 | 文档完整度、命令边界清晰度、回归排查速度 | 每项任务必须有文档与验证证据 |

## Workstream Overview

| Workstream | Priority | Status | Progress | Why First |
| --- | --- | --- | --- | --- |
| WS1 平台稳定层 | P0 | in_progress | 10% | 所有上层能力都依赖这里的稳定性 |
| WS2 AI Runtime 内核 | P0 | planned | 0% | 决定聊天、技能、工具、自动化的可控性 |
| WS3 知识与检索 | P1 | planned | 0% | 决定 grounded answer 与知识工作流质量 |
| WS4 稿件与视频生产 | P0 | planned | 0% | 决定核心创作链路是否可扩展 |
| WS5 RedClaw 与 Workboard | P1 | planned | 0% | 决定长期任务与自动化执行能力 |
| WS6 设置、观测与恢复 | P1 | planned | 0% | 决定回归排查和版本维护成本 |
| WS7 文档与工程治理 | P1 | in_progress | 15% | 决定后续优化是否可持续推进 |
| WS8 Team 协作与 ACP | P1 | planned | 0% | 决定多人协作、外部 agent 接入和团队工作流扩展 |

## Master Tracker

| ID | Workstream | Task | Priority | Status | Progress | Dependencies | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RM-00 | Governance | 建立统一 roadmap 与更新机制 | P0 | done | 100% | none | 归档：`archive/completed-tasks-archive-2026-04-23.md` |
| WS1-01 | 平台稳定层 | 收敛 App Shell 页面加载与缓存策略 | P0 | ready | 0% | none | 切页、刷新、回跳验证 |
| WS1-02 | 平台稳定层 | 统一 bridge typed helper 与 fallback contract | P0 | ready | 0% | none | 真实页面调用 IPC 验证 |
| WS1-03 | 平台稳定层 | 拆薄 `main.rs`，新增命令域装配边界 | P0 | planned | 0% | WS1-02 | cargo check + 页面回归 |
| WS1-04 | 平台稳定层 | workspace hydration 走最小快照 + 分阶段加载 | P0 | planned | 0% | WS1-01 | 冷启动、切 space、重载验证 |
| WS2-01 | AI Runtime | `context bundle`、skill overlay、tool contract 收口 | P0 | planned | 0% | WS1-02 | 真实任务 + diagnostics |
| WS2-02 | AI Runtime | approval runtime 与 tool policy 收口 | P0 | planned | 0% | WS2-01 | 工具确认、拒绝、恢复验证 |
| WS2-03 | AI Runtime | session / checkpoint / transcript 恢复链路收口 | P0 | planned | 0% | WS2-01 | 真实会话恢复验证 |
| WS2-04 | AI Runtime | subagent 与 MCP 调度边界治理 | P1 | planned | 0% | WS2-02 | 多任务执行与权限验证 |
| WS2-05 | AI Runtime | 内置 vLLM 运行时与本地模型托管 | P1 | planned | 0% | WS1-02 | 本地模型拉起、切换、回退验证 |
| WS2-06 | AI Runtime | 记忆模块升级重做 | P0 | planned | 0% | WS2-01 | recall、maintenance、写回验证 |
| WS2-07 | AI Runtime | 记忆 dreaming 自动整理能力 | P0 | planned | 0% | WS2-06 | 记忆整理任务可调度、可回溯、可恢复 |
| WS2-08 | AI Runtime | 简化工具调用复杂度 | P0 | planned | 0% | WS2-01, WS2-02 | 工具链路可观测性、失败率下降、调用延迟下降 |
| WS3-01 | 知识与检索 | 文档摄取 pipeline 统一切片和元数据结构 | P1 | planned | 0% | WS1-04 | 多格式导入验证 |
| WS3-02 | 知识与检索 | 检索结果加引用、来源与重排序策略 | P1 | planned | 0% | WS3-01 | grounded answer 验证 |
| WS3-03 | 知识与检索 | 索引重建改为增量任务和后台调度 | P1 | planned | 0% | WS3-01 | 大库重建耗时验证 |
| WS3-04 | 知识与检索 | 新闻源接入与时效化知识更新链路 | P1 | planned | 0% | WS3-01 | RSS/Atom/API 接入、去重更新、召回可见性 |
| WS4-01 | 稿件与视频生产 | Manuscripts 数据模型与编辑状态机收口 | P0 | planned | 0% | WS1-04 | 稿件编辑、刷新恢复验证 |
| WS4-02 | 稿件与视频生产 | 时间线数据结构、虚拟化与大稿件性能治理 | P0 | planned | 0% | WS4-01 | 长时间线操作验证 |
| WS4-03 | 稿件与视频生产 | 预览渲染与导出编排分层 | P0 | planned | 0% | WS4-02 | 预览流畅度 + 导出成功率 |
| WS4-04 | 稿件与视频生产 | 媒体生成、素材绑定与封面工作流收口 | P1 | planned | 0% | WS4-03 | 素材到稿件闭环验证 |
| WS4-05 | 稿件与视频生产 | 自动剪视频工作流 | P0 | planned | 0% | WS4-01, WS4-02, WS4-03 | 从素材到粗剪成片验证 |
| WS4-06 | 稿件与视频生产 | AI 生成动画工作流 | P1 | planned | 0% | WS4-03, WS4-04 | 动画生成、预览、导出验证 |
| WS5-01 | RedClaw 与 Workboard | 任务定义、执行记录、状态机统一 | P1 | planned | 0% | WS2-03 | 长任务生命周期验证 |
| WS5-02 | RedClaw 与 Workboard | scheduler 与 runtime 解耦 | P1 | planned | 0% | WS5-01 | 定时、补偿、失败恢复验证 |
| WS5-03 | RedClaw 与 Workboard | Workboard 成为统一执行看板 | P2 | planned | 0% | WS5-01 | 多任务并行和筛选验证 |
| WS5-04 | RedClaw 与 Workboard | 定时任务系统升级为统一 cron / recurring job 平台 | P1 | planned | 0% | WS5-01, WS5-02 | 创建、编辑、触发、补偿验证 |
| WS6-01 | 设置、观测与恢复 | Settings diagnostics 建立统一 runtime summary | P1 | planned | 0% | WS2-01 | diagnostics 面板验证 |
| WS6-02 | 设置、观测与恢复 | 错误恢复、重试、日志定位工具统一 | P1 | planned | 0% | WS6-01 | 故障注入验证 |
| WS7-01 | 文档与工程治理 | 重要模块补“入口-职责-验证”文档 | P1 | in_progress | 20% | none | 文档可追溯性检查 |
| WS7-02 | 文档与工程治理 | 建立优化任务的验收记录模板 | P1 | ready | 0% | RM-00 | 每项任务有证据链接 |
| WS8-01 | Team 协作与 ACP | Team 模块升级为统一协作控制台 | P1 | planned | 0% | WS2-03 | 多成员协作、群聊、任务分发验证 |
| WS8-02 | Team 协作与 ACP | ACP 模块升级，统一外部 agent 协作协议 | P1 | planned | 0% | WS2-04, WS8-01 | ACP 探测、握手、执行、回收验证 |

## Detailed Workstreams

### WS1 平台稳定层

#### Goal

先把页面切换、bridge、host 装配、workspace hydration 稳住，避免所有功能优化都在不稳定基座上返工。

#### Implementation Rules

- renderer 只走 `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src-tauri/src/main.rs` 只保留装配与路由
- 页面切换遵循 `render shell first, hydrate later`
- 刷新失败保留旧数据，不允许整页清空
- workspace / 文件扫描必须留在 persistence / loaders

#### Task Card: WS1-01

| Field | Detail |
| --- | --- |
| Task | 收敛 App Shell 页面加载与缓存策略 |
| Status | ready |
| Progress | 0% |
| Entry Points | `desktop/src/App.tsx`, `desktop/src/components/Layout.tsx`, `desktop/src/pages/*` |
| Why | 当前 `MAX_CACHED_VIEWS = 0`，切页会触发重复 hydrate；如果没有明确缓存规则，后续每页都要各自修性能 |
| Implementation | 以页面类型区分缓存策略：重状态页保留摘要态，重 I/O 页保留快照态，极重编辑页保留局部运行态；引入统一 view activation contract，而不是每页自行决定首屏请求 |
| Existing Libraries | React lazy、Suspense |
| Must Self Build | page activation state、缓存白名单、stale snapshot model |
| Performance Strategy | 切页时只恢复最近快照，不在首帧阻塞慢 IPC；页面详情请求可取消，旧请求不得覆盖新导航结果 |
| Verification | Chat、Knowledge、Manuscripts、Settings 来回切换；已有数据保留；刷新失败出现内联错误而不是空白页 |
| Cleanup | 删除各页面散落的重复 loading state 和 ad hoc 首屏请求逻辑 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS1-02

| Field | Detail |
| --- | --- |
| Task | 统一 bridge typed helper 与 fallback contract |
| Status | ready |
| Progress | 0% |
| Entry Points | `desktop/src/bridge/ipcRenderer.ts`, `desktop/src/runtime/runtimeEventStream.ts`, 各页面 IPC 调用点 |
| Why | 现在 bridge 已有兼容与 fallback，但 contract 未完全收口，页面仍容易依赖隐式 payload |
| Implementation | 以 domain helper 组织桥接接口，例如 `runtime.*`、`knowledge.*`、`manuscripts.*`；每个 helper 明确 success payload、empty payload、error fallback；逐步清理页面裸 channel 字符串 |
| Existing Libraries | Tauri event/core API |
| Must Self Build | contract typing、fallback normalization、compat alias layer |
| Performance Strategy | bridge 统一超时与降级；运行时事件统一单通道分发，避免重复 listener 和事件风暴 |
| Verification | 真实执行 Chat、Knowledge、Settings、RedClaw 的 host 调用；断开部分 host 能力时 UI 不崩 |
| Cleanup | 清除页面中重复的 `invoke/listen` 封装和历史兼容逻辑 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS1-03

| Field | Detail |
| --- | --- |
| Task | 拆薄 `main.rs`，新增命令域装配边界 |
| Status | completed |
| Progress | 100% |
| Entry Points | `desktop/src-tauri/src/main.rs`, `desktop/src-tauri/src/commands/*` |
| Why | `main.rs` 仍承载过多结构体和装配逻辑，继续堆叠会让回归面和编译成本持续上升 |
| Implementation | 保留 app bootstrap、state 注册、command 注册；把业务 record、helper、domain wiring 下沉到 `commands/*` 或 `runtime/*`；按 chat / manuscripts / knowledge / redclaw / system 域分层 |
| Existing Libraries | Tauri command system、serde |
| Must Self Build | domain boundary、共享 state 访问模式 |
| Performance Strategy | 命令读取最小快照，锁外执行 I/O 和 CPU 重活，再回锁应用内存变更 |
| Verification | `cargo check`、真实页面调用、启动流程回归 |
| Cleanup | 清理 `main.rs` 中不属于装配层的 record/helper |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS1-04

| Field | Detail |
| --- | --- |
| Task | workspace hydration 走最小快照 + 分阶段加载 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/persistence/*`, `desktop/src-tauri/src/workspace_loaders.rs`, `desktop/src-tauri/src/commands/workspace_data.rs` |
| Why | 当前空间切换和数据恢复容易把文件扫描、hydrate、页面激活耦在一起，直接拖慢首屏 |
| Implementation | store 中只保留 summary、path、count、fingerprint；详细稿件、知识、媒体列表改为按页面后台拉取；引入 hydration stage 标识，允许 renderer 渐进式展示 |
| Existing Libraries | serde_json、文件系统 API |
| Must Self Build | workspace schema、summary snapshot、hydration scheduler |
| Performance Strategy | 锁内只读 state；锁外完成目录扫描、文件解析和索引 warmup |
| Verification | 冷启动、切换 workspace、重开应用、已有数据恢复 |
| Cleanup | 删除 page load 上的目录扫描和大 payload 初始化 |
| Last Update | 2026-04-23 初始化 |

### WS2 AI Runtime 内核

#### Goal

把聊天、技能、工具、审批、MCP、子代理统一成稳定 runtime，而不是继续在页面和消息文本层拼逻辑。

#### Implementation Rules

- 能力边界优先写在 `skills`、`prompts`、`tool contract`
- intent 优先用 typed metadata 和 runtime mode，不靠关键词
- tool 保持单一职责、结构化、可组合
- session / task / checkpoint / transcript 必须能恢复和审计

#### Task Card: WS2-01

| Field | Detail |
| --- | --- |
| Task | `context bundle`、skill overlay、tool contract 收口 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/runtime/context_bundle.rs`, `desktop/src-tauri/src/skills/*`, `desktop/src-tauri/src/tools/*`, `desktop/prompts/*` |
| Why | 当前 prompt、skills、tools 已有基础，但还缺统一预算、来源和注入边界 |
| Implementation | 统一 context section：identity、workspace rules、runtime mode、skills、memory、tool contract、turn input；每段有来源、预算、截断、scan result；skill 只声明能力边界，不直接覆盖运行时协议 |
| Existing Libraries | serde、LLM transport |
| Must Self Build | context assembly、budget policy、tool permission contract |
| Performance Strategy | prompt summary 缓存、按需注入、避免每轮全量拼大文档 |
| Verification | 真实 chat / wander / redclaw 任务；对比 prompt 摘要、技能启用、工具可见性 |
| Cleanup | 清理 prompt 中重复规则、页面侧消息启发式路由 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS2-02

| Field | Detail |
| --- | --- |
| Task | approval runtime 与 tool policy 收口 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/runtime/approval_runtime.rs`, `desktop/src-tauri/src/tools/guards.rs`, `desktop/src-tauri/src/tools/packs.rs` |
| Why | 工具确认、拒绝、重试如果不统一，AI 行为会越来越不可预测 |
| Implementation | 统一 pending approval record、tool scope、审批结果落盘、超时和取消策略；按 runtime mode 限制 tool pack，而不是在 prompt 里口头约束 |
| Existing Libraries | JSON schema、现有 host event 流 |
| Must Self Build | approval state machine、policy evaluator、capability pack governance |
| Performance Strategy | 审批状态更新只走最小事件，不回传大对象；Settings diagnostics 只汇总摘要 |
| Verification | `bash`、`app_cli`、编辑类工具的确认/取消/恢复流程 |
| Cleanup | 删除散落在工具执行处的 ad hoc 权限判断 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS2-03

| Field | Detail |
| --- | --- |
| Task | session / checkpoint / transcript 恢复链路收口 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/agent/session.rs`, `desktop/src-tauri/src/agent/persistence.rs`, `desktop/src-tauri/src/runtime/session_runtime.rs` |
| Why | 没有稳定恢复链路，长会话、后台任务和自动化会持续丢上下文 |
| Implementation | 明确 session summary、transcript tail、checkpoint digest、tool result artifact 的职责；恢复优先读取摘要，再按需拉 transcript 和 artifacts |
| Existing Libraries | serde_json、文件系统 |
| Must Self Build | artifact partitioning、lineage model、restore policy |
| Performance Strategy | transcript / tool result 大对象分文件；renderer 只取 summary 和 tail |
| Verification | 重启 app、恢复对话、恢复任务、查看历史回放 |
| Cleanup | 清理 session 状态中重复存储和大对象直接挂载 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS2-04

| Field | Detail |
| --- | --- |
| Task | subagent 与 MCP 调度边界治理 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/subagents/*`, `desktop/src-tauri/src/mcp/*`, `desktop/src-tauri/src/runtime/orchestration_runtime.rs` |
| Why | 子代理和 MCP 是能力放大器，但如果边界不清晰，会快速引入黑盒和权限扩散 |
| Implementation | 子代理只处理明确定义、可验证的子任务；MCP session 生命周期、tool exposure、timeout、auth 状态要显式；主 runtime 持有调度和汇总权 |
| Existing Libraries | MCP 协议实现、现有 transport |
| Must Self Build | delegation policy、result aggregation、server capability exposure |
| Performance Strategy | 仅对非阻塞侧任务启用 subagent；MCP server 复用连接，避免每轮重建 |
| Verification | 多工具任务、外部 server 可用性、权限失败和超时回退 |
| Cleanup | 禁止工具里再套 agent 黑盒 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS2-05

| Field | Detail |
| --- | --- |
| Task | 内置 vLLM 运行时与本地模型托管 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src/config/aiSources.ts`, `desktop/src/pages/Settings.tsx`, `desktop/src-tauri/src/cli_runtime/*`, `desktop/src-tauri/src/llm_transport/*` |
| Why | 当前已经有 `vllm-local` 配置入口，但仍停留在“手动外部启动”模式，不足以支撑真正的本地推理工作流 |
| Implementation | 把 vLLM 从“外部可选 endpoint”升级成“宿主可管理 runtime”：检测 Python / vLLM 环境、生成 serve 参数、启动/停止进程、健康检查、模型列表、端口占用处理、日志摘要、失败回退到远程 provider |
| Existing Libraries | vLLM、OpenAI-compatible protocol、现有 CLI runtime 框架 |
| Must Self Build | 本地 runtime lifecycle、模型注册、资源占用治理、UI 运维入口 |
| Performance Strategy | 启动前先做环境探测；模型切换走复用与热状态摘要；首轮请求前缓存 health 状态，避免页面每次重复探测 |
| Verification | Settings 启动本地 vLLM、切换模型、发送真实 chat、异常退出自动感知与回退 |
| Cleanup | 删除“只给命令提示不负责托管”的半成品入口 |
| Last Update | 2026-04-25 已完成 Workboard 协作控制台、成员/任务/汇报状态机、内部 subagent 看板投影和外部 ACP 成员入口 |

#### Task Card: WS2-06

| Field | Detail |
| --- | --- |
| Task | 记忆模块升级重做 |
| Status | completed |
| Progress | 100% |
| Entry Points | `desktop/src-tauri/src/memory/*`, `desktop/src-tauri/src/agent/persistence.rs`, `desktop/src-tauri/src/runtime/context_bundle.rs`, `desktop/src-tauri/src/diagnostics.rs` |
| Why | 当前 memory 虽然已独立成子系统，但仍混合了 durable memory、maintenance status、prompt summary 和历史痕迹，边界还不够硬 |
| Implementation | 明确三层结构：`durable memory`、`episodic learnings`、`session history evidence`；重做 recall pipeline、写回策略、维护任务、冲突合并和权限控制；让 memory 成为真正可治理的 runtime 子系统，而不是历史对话的附属品 |
| Existing Libraries | serde、文件系统、现有 recall/maintenance 基础 |
| Must Self Build | memory schema、recall ranking、write policy、maintenance policy、memory diagnostics |
| Performance Strategy | recall 只检索必要层级；memory summary 缓存；maintenance 后台化；大 history 不直接注入 prompt |
| Verification | `memory:list/search/add`、真实 chat recall、生效后的 maintenance、重启后持久化恢复 |
| Cleanup | 删除 settings fallback JSON、历史兼容写法和 memory/history 混用结构 |
| Last Update | 2026-04-25 已完成 ACP 后端探测、`redbox-team` MCP 合同、bridge 配置、外部 ACP/CLI runner、stdout/stderr/退出码回写和失败回退状态 |

#### Task Card: WS2-07

| Field | Detail |
| --- | --- |
| Task | 记忆 dreaming 自动整理能力 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/memory/*`, `desktop/src-tauri/src/memory_maintenance.rs`, `desktop/src-tauri/src/commands/chat_state.rs`, `desktop/src-tauri/src/agent/persistence.rs` |
| Why | 当前 memory 缺少“离线整理”闭环，记忆累计导致 recall 成本上升，难以追溯哪些条目已做过整理与归并 |
| Implementation | 新增 sleeping scheduler：支持手动与自动触发；对历史记忆做聚类/去重/摘要重写；输出可版本化的 consolidation artifact，并与会话 recall 链路解耦，避免写入路径串扰 |
| Existing Libraries | `serde_json`、文件系统 API、现有 recall 与 maintenance 基础 |
| Must Self Build | dreaming scheduler、artifact 冲突合并策略、maintenance 回溯审计 |
| Performance Strategy | 仅在空闲时段跑全量整理，常规只做增量；整理任务按窗口分页并限流，降低对实时会话的资源竞争 |
| Verification | `dreaming` 任务可手动/自动触发；任务状态可查；整理前后 recall 一致性不降低且延迟下降 |
| Cleanup | 禁止记忆整理逻辑在会话实时链路直接运行，避免阻塞与结果抖动 |
| Last Update | 2026-04-24 新增 |

#### Task Card: WS2-08

| Field | Detail |
| --- | --- |
| Task | 简化工具调用复杂度 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/tools/*`, `desktop/src-tauri/src/commands/*`, `desktop/src-tauri/src/runtime/*`, `desktop/src/bridge/ipcRenderer.ts` |
| Why | 当前工具链路散落多个入口、参数约定不统一，导致重复适配、排障链路长、调用抖动不可控 |
| Implementation | 统一工具调用入口与 payload schema：建立 `tool invocation graph`，按 capability 映射到最小 tool；统一工具输入校验、错误码、超时与重试；对旧入口保留兼容 adapter，逐步收敛到单一 typed 调用层 |
| Existing Libraries | serde、Tauri invoke、现有 host command / tool registry |
| Must Self Build | tool graph 定义、统一错误语义、trace-id 链路、兼容 adapter |
| Performance Strategy | 缩短调用链，减少中间转换层；高频工具走缓存/批处理；失败重试采用抖动退避避免雪崩 |
| Verification | 真实任务下对齐 tool 使用路径；可观察到单一 trace-id；常见工具错误返回统一且可解析 |
| Cleanup | 清理页面或 runtime 的 ad hoc 工具拼包逻辑，删除重复解析与重复 fallback |
| Last Update | 2026-04-25 新增 |

### WS3 知识与检索

#### Goal

把知识摄取、索引、召回、引用做成可审计且可扩展的 pipeline，支撑 AI grounded answer，而不是只返回模糊片段。

#### Task Card: WS3-01

| Field | Detail |
| --- | --- |
| Task | 文档摄取 pipeline 统一切片和元数据结构 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/document_ingest/*`, `desktop/src-tauri/src/knowledge_index/*`, `desktop/src-tauri/src/commands/library.rs` |
| Implementation | 按 source type 统一抽象 ingest record、normalized document、chunk record、source fingerprint；保留文件级、段落级、chunk 级 metadata |
| Existing Libraries | 文件解析库、嵌入模型、watcher |
| Must Self Build | chunk policy、source schema、rebuild planner |
| Performance Strategy | 增量摄取、内容 fingerprint 去重、后台重建任务 |
| Verification | PDF、网页、转录文本、长文档导入与重建 |
| Cleanup | 清除按来源分散的临时 metadata 结构 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS3-02

| Field | Detail |
| --- | --- |
| Task | 检索结果加引用、来源与重排序策略 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/tools/knowledge_search.rs`, `desktop/src-tauri/src/runtime/*`, `desktop/src/pages/Knowledge.tsx` |
| Implementation | 先召回，再做 metadata-aware rerank；输出必须携带 source id、title、path、offset、confidence、snippet，不允许只返回自由文本 |
| Existing Libraries | 向量检索库、rerank 模型 |
| Must Self Build | citation contract、answer grounding format |
| Performance Strategy | 结果摘要与全文片段分层返回，首屏先出引用摘要 |
| Verification | grounded answer、引用跳转、错误来源回退 |
| Cleanup | 删除非结构化的知识检索输出 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS3-03

| Field | Detail |
| --- | --- |
| Task | 索引重建改为增量任务和后台调度 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/knowledge_index/*`, `desktop/src-tauri/src/scheduler/*` |
| Implementation | 引入 catalog diff、dirty queue、后台 rebuild worker、重建事件流；页面只展示状态，不直接触发长阻塞操作 |
| Existing Libraries | 文件 watcher、后台任务基础能力 |
| Must Self Build | incremental rebuild state、retry policy |
| Performance Strategy | 文件改动后只重建受影响 source；大库分批处理 |
| Verification | 大知识库增量更新、失败重试、索引恢复 |
| Cleanup | 删除全量重扫触发的 page-path 重建 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS3-04

| Field | Detail |
| --- | --- |
| Task | 新闻源接入与时效化知识更新链路 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/knowledge_index/*`, `desktop/src-tauri/src/document_ingest/*`, `desktop/src-tauri/src/scheduler/*`, `desktop/src-tauri/src/commands/library.rs` |
| Why | 当前知识体系主要依赖文档和素材，缺少结构化新闻采集入口，时效信息无法持续进入检索与回复链路 |
| Implementation | 引入统一 `news source connector`：支持 RSS/Atom/JSON API 采集，保存 raw feed 与 canonical article；做 URL/内容签名去重、时间窗归档、来源可信度权重，接入增量索引更新链路，支持全量同步与增量定时更新两种模式 |
| Existing Libraries | feed parser、HTTP client、JSON parser、现有 knowledge index |
| Must Self Build | 新闻源配置 schema、增量抓取状态机、时效性排序与失效回收策略 |
| Performance Strategy | 采集按频率分组、并发数限流，优先增量头条拉取，失败源进入指数退避，不阻塞主线程主检索 |
| Verification | 配置并抓取至少 1 个新闻源，验证增量更新、去重、时效字段；检索命中后可追溯 source 与发布时间 |
| Cleanup | 把新闻采集并入统一知识摄取与索引流水线，避免形成独立未编排的数据支线 |
| Last Update | 2026-04-24 新增 |

### WS4 稿件与视频生产

#### Goal

把 Manuscripts、时间线、预览、导出做成一条稳定生产链，而不是编辑器、渲染器、导出器各自保存一套状态。

#### Recommended Implementation Choice

视频链路有两种常见实现：

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 纯前端时间线 + 独立导出脚本 | 开发快 | 编辑态、预览态、导出态容易分叉 | 不推荐长期使用 |
| 统一稿件模型 -> 时间线投影 -> 预览/导出共享编排 | 数据一致性高，适合 AI 生成与自动化批处理 | 前期模型设计要求更高 | 推荐 |

本 roadmap 采用第二种方案。

#### Task Card: WS4-01

| Field | Detail |
| --- | --- |
| Task | Manuscripts 数据模型与编辑状态机收口 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src/pages/Manuscripts.tsx`, `desktop/src/components/manuscripts/*`, `desktop/src-tauri/src/commands/manuscripts.rs` |
| Implementation | 明确 manuscript package、scene、track item、asset binding、theme、script proposal 的 schema；编辑器只改 canonical state，派生视图不反写多套结构 |
| Existing Libraries | 编辑器基础组件、CodeMirror 等 |
| Must Self Build | manuscript package schema、editing state machine、proposal merge logic |
| Performance Strategy | 文稿大对象分块保存；编辑态局部更新，不做整包重序列化 |
| Verification | 写作、脚本更新、刷新恢复、历史回滚 |
| Cleanup | 删除稿件状态的重复映射和一次性全量保存逻辑 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS4-02

| Field | Detail |
| --- | --- |
| Task | 时间线数据结构、虚拟化与大稿件性能治理 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src/features/video-editor/*`, `desktop/src/components/manuscripts/timeline/*`, `desktop/src/features/video-editor/store/useVideoEditorStore.ts` |
| Implementation | 将 timeline entity 规范成 track、clip、transition、subtitle、viewport state；长时间线只渲染可见区和邻近区；拖拽、缩放、吸附逻辑从 UI 组件中抽离到 store/helper |
| Existing Libraries | 已集成视频编辑基础库、浏览器渲染能力 |
| Must Self Build | timeline projection、virtual window、editor interaction rules |
| Performance Strategy | 虚拟列表、局部重绘、波形与缩略图缓存、重计算节流 |
| Verification | 长时间线拖动、缩放、字幕编辑、撤销重做 |
| Cleanup | 清除 render path 中的重计算和 ad hoc 状态同步 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS4-03

| Field | Detail |
| --- | --- |
| Task | 预览渲染与导出编排分层 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src/remotion/*`, `desktop/remotion/render.mjs`, `desktop/src/vendor/freecut/*` |
| Implementation | 编辑态只维护 canonical timeline；预览层生成轻量 preview graph；导出层生成 render graph 和 asset manifest；统一字体、转场、字幕、BGM、旁白资源解析 |
| Existing Libraries | Remotion、媒体探测/转码库 |
| Must Self Build | render orchestration、asset manifest、preview/export parity contract |
| Performance Strategy | 预览优先低分辨率代理素材；导出阶段并发受控、缓存中间结果、避免重复 probe |
| Verification | 预览一致性、导出成功率、失败重试、长视频导出 |
| Cleanup | 删除预览与导出各自维护不同字段的逻辑 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS4-04

| Field | Detail |
| --- | --- |
| Task | 媒体生成、素材绑定与封面工作流收口 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src/pages/MediaLibrary.tsx`, `desktop/src/pages/CoverStudio.tsx`, `desktop/src-tauri/src/media_generation.rs`, `desktop/src-tauri/src/commands/generation.rs` |
| Implementation | 统一 media asset record、generation job、cover template、binding target；生成结果直接可绑定到稿件和 subject，而不是停留在独立素材页 |
| Existing Libraries | 模型 API、媒体生成 SDK |
| Must Self Build | asset binding、job trace、template contract |
| Performance Strategy | 生成任务后台化、缩略图与预览缓存、失败任务可恢复 |
| Verification | 文生图、封面生成、素材绑定到稿件/主体 |
| Cleanup | 清除生成任务与素材实体的重复记录 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS4-05

| Field | Detail |
| --- | --- |
| Task | 自动剪视频工作流 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src/pages/Manuscripts.tsx`, `desktop/src/features/video-editor/*`, `desktop/src/components/manuscripts/*`, `desktop/src-tauri/src/commands/manuscripts.rs`, `desktop/src-tauri/src/commands/generation.rs` |
| Why | 这是核心生产力功能，必须从“素材仓库”推进到“可自动产出粗剪结果”的完整工作流 |
| Implementation | 建立 `ingest -> transcript/segment -> shot selection -> timeline assembly -> rough-cut review -> export` 链路；输入支持长视频、分镜脚本、口播稿、素材包；输出必须是可继续编辑的 canonical timeline，而不是一次性导出黑盒视频 |
| Existing Libraries | 媒体探测/转码库、转录能力、现有 timeline / Remotion 基础 |
| Must Self Build | 剪辑策略引擎、片段打分、b-roll 插入规则、节奏模板、粗剪解释信息 |
| Performance Strategy | 先生成 segment summary 和 edit decision list，再异步装配时间线；代理素材、波形缓存、缩略图缓存默认开启 |
| Verification | 导入素材后自动生成粗剪；用户可在时间线继续修；粗剪结果可预览、可导出、可重跑 |
| Cleanup | 禁止把自动剪辑逻辑写成单个黑盒 tool；必须保留结构化中间结果 |
| Last Update | 2026-04-23 新增 |

#### Task Card: WS4-06

| Field | Detail |
| --- | --- |
| Task | AI 生成动画工作流 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src/pages/MediaLibrary.tsx`, `desktop/src/pages/CoverStudio.tsx`, `desktop/src/components/manuscripts/*`, `desktop/src-tauri/src/media_generation.rs`, `desktop/src-tauri/src/commands/generation.rs`, `desktop/src/remotion/*` |
| Why | 静态素材生成已经有基础，但动画仍未成为一等公民，无法直接进入稿件和视频生产链 |
| Implementation | 区分两类动画：`template-based motion graphics` 和 `model-generated animation`；前者基于 Remotion/模板参数生成，后者基于视频/动画模型生成片段；两者都落成统一 `animation asset record`，可直接绑定到 timeline |
| Existing Libraries | Remotion、图像/视频生成模型 API |
| Must Self Build | animation asset schema、prompt-to-animation contract、模板参数系统、timeline binding |
| Performance Strategy | 先产预览 gif/mp4 代理，再后台渲染正式素材；同 prompt 的动画资产支持复用和缓存 |
| Verification | 输入文案或脚本生成动画；动画可预览、可插入时间线、可导出成片 |
| Cleanup | 清理动画只存在于文本 preset 或零散生成任务中的状态 |
| Last Update | 2026-04-23 新增 |

### WS5 RedClaw 与 Workboard

#### Goal

让 RedClaw 成为真正的长期任务运行时，而不是“调度器 + 页面字段 + 零散 worker”的组合。

#### Task Card: WS5-01

| Field | Detail |
| --- | --- |
| Task | 任务定义、执行记录、状态机统一 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/commands/redclaw.rs`, `desktop/src-tauri/src/commands/redclaw_runtime.rs`, `desktop/src-tauri/src/runtime/*` |
| Implementation | 区分 definition、schedule、execution、artifact、operator note；所有 RedClaw 与 Workboard 都消费同一 execution record |
| Existing Libraries | 现有 runtime 和 scheduler 基础 |
| Must Self Build | job schema、execution state machine、artifact contract |
| Performance Strategy | 只在列表页拉 execution summary；详情按需读取日志与产物 |
| Verification | 创建、执行、取消、重试、恢复任务 |
| Cleanup | 删除 UI 字段直接驱动状态机的写法 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS5-02

| Field | Detail |
| --- | --- |
| Task | scheduler 与 runtime 解耦 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/scheduler/*`, `desktop/src-tauri/src/runtime/*` |
| Implementation | scheduler 只负责“何时触发哪个 definition”；runtime 负责“如何执行、如何恢复、如何记录”；避免 scheduler 直接改业务状态 |
| Existing Libraries | 时间与任务调度基础设施 |
| Must Self Build | trigger contract、compensation policy、resume protocol |
| Performance Strategy | 定时触发只入队，不同步做重活；失败任务用单独补偿队列 |
| Verification | daily/weekly 任务、DST、本地时区、补偿执行 |
| Cleanup | 删除 scheduler 中的业务逻辑膨胀 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS5-03

| Field | Detail |
| --- | --- |
| Task | Workboard 成为统一执行看板 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src/pages/Workboard.tsx`, `desktop/src/pages/redclaw/*` |
| Implementation | 用统一 execution summary 展示待处理、运行中、失败、完成；支持筛选、恢复、跳转产物；不再让不同自动化页面各自维护不同状态口径 |
| Existing Libraries | React、现有列表组件 |
| Must Self Build | board query model、operator actions |
| Performance Strategy | 看板列表分页、状态分桶、增量刷新 |
| Verification | 多任务并发、筛选、详情跳转、恢复动作 |
| Cleanup | 合并重复任务列表与历史抽屉逻辑 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS5-04

| Field | Detail |
| --- | --- |
| Task | 定时任务系统升级为统一 cron / recurring job 平台 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/scheduler/*`, `desktop/src-tauri/src/commands/runtime_tasks.rs`, `desktop/src-tauri/src/commands/redclaw_runtime.rs`, `desktop/src/pages/Workboard.tsx`, `desktop/src/pages/RedClaw.tsx` |
| Why | 现在定时与自动化能力分散在 scheduler、RedClaw、memory maintenance 等不同路径，不利于维护和产品化 |
| Implementation | 抽出统一 `job definition / trigger / execution / retry / compensation / operator action` 模型；支持 cron、daily、weekly、interval；区分“纯定时任务”“带上下文持续任务”“维护类任务”；统一落到 Workboard 和 RedClaw 视图 |
| Existing Libraries | 时间调度基础设施、现有 runtime task 能力 |
| Must Self Build | trigger schema、补偿策略、时区/DST 处理、任务可恢复执行模型 |
| Performance Strategy | 定时触发只入队不直接执行重任务；批量任务限流；长任务心跳写摘要而非全量日志 |
| Verification | 创建、编辑、暂停、恢复、立即执行、DST 边界、失败补偿 |
| Cleanup | 清理散落在 memory maintenance、daemon、RedClaw 内的独立调度入口 |
| Last Update | 2026-04-23 新增 |

### WS8 Team 协作与 ACP

#### Goal

把 Team 从“页面能力集合”升级成统一协作控制台，并把外部 ACP agent 接入到同一套协作协议里。

#### Implementation Rules

- Team 是 orchestration surface，不是另一个临时聊天页
- 内部 child runtime 与外部 ACP agent 必须走统一协作动作模型
- 协作成员必须有明确身份、能力、上下文范围、写权限和产物回传路径
- 页面 UI 只展示结构化成员状态、任务状态、结果摘要，不解析自由文本协议

#### Task Card: WS8-01

| Field | Detail |
| --- | --- |
| Task | Team 模块升级为统一协作控制台 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src/pages/Team.tsx`, `desktop/src/pages/Advisors.tsx`, `desktop/src/pages/CreativeChat.tsx`, `desktop/src-tauri/src/commands/advisor_ops.rs`, `desktop/src-tauri/src/commands/chatrooms.rs` |
| Why | 现在 Team 更像 advisors / group chat 的组合页，还不是完整的多成员协作执行面板 |
| Implementation | 统一 Team member、role、knowledge binding、task assignment、conversation room、artifact summary；把 advisor、group chat、协作任务、执行结果整合为单一 team workspace，而不是多个分散页面 |
| Existing Libraries | React、现有 advisors/chatrooms 基础 |
| Must Self Build | team member schema、assignment model、collaboration event model、team workspace UI |
| Performance Strategy | 成员列表、房间列表、任务摘要分层加载；历史消息按 room 和 session 懒加载 |
| Verification | 创建成员、分配任务、群聊协作、查看结果、回到主 chat / manuscripts 的联动 |
| Cleanup | 收敛 Team、Advisors、CreativeChat 间重复状态与重复入口 |
| Last Update | 2026-04-23 新增 |

#### Task Card: WS8-02

| Field | Detail |
| --- | --- |
| Task | ACP 模块升级，统一外部 agent 协作协议 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/docs/agent-collaboration-upgrade-plan.md`, `desktop/src-tauri/src/subagents/*`, `desktop/src-tauri/src/mcp/*`, `desktop/src-tauri/src/runtime/orchestration_runtime.rs` |
| Why | 仓库里已经有明确的 ACP 协作方向，但还没有把外部 ACP agent 升级成产品级能力 |
| Implementation | 以内部 child runtime 为默认执行内核，以外部 ACP agent 为可插拔协作成员；增加 ACP CLI 探测、握手、session lifecycle、capability injection、result aggregation、错误恢复；统一纳入 Team 控制台和 runtime orchestration |
| Existing Libraries | ACP CLI / bridge 生态、现有 MCP 与 subagent 基础 |
| Must Self Build | ACP adapter、session state machine、team MCP bridge、capability governance |
| Performance Strategy | 只对明确的协作任务创建 ACP session；连接复用；握手与探测结果缓存；失败快速降级回内部 child runtime |
| Verification | 假 ACP agent 握手、真实 ACP agent 探测、混合协作任务、超时和失败回退 |
| Cleanup | 禁止让外部 ACP agent 走单独黑盒分支；必须统一到协作控制平面 |
| Last Update | 2026-04-23 新增 |

### WS6 设置、观测与恢复

#### Goal

建立统一 diagnostics、日志、恢复路径，让性能优化和 bug 修复有证据而不是靠猜。

#### Task Card: WS6-01

| Field | Detail |
| --- | --- |
| Task | Settings diagnostics 建立统一 runtime summary |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src/pages/Settings.tsx`, `desktop/src/pages/settings/SettingsSections.tsx`, `desktop/src-tauri/src/diagnostics.rs` |
| Implementation | 汇总 prompt chars、active skills、tool pack、pending approvals、runtime warm state、recent failures、workspace hydration stage |
| Existing Libraries | 现有 diagnostics 汇总结构 |
| Must Self Build | runtime summary schema、UI grouping |
| Performance Strategy | diagnostics 优先返回 summary，详情延迟加载 |
| Verification | 冷开 Settings、热切换、错误时可定位 |
| Cleanup | 合并分散 diagnostics 入口 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS6-02

| Field | Detail |
| --- | --- |
| Task | 错误恢复、重试、日志定位工具统一 |
| Status | planned |
| Progress | 0% |
| Entry Points | `desktop/src-tauri/src/logging/*`, `desktop/src/logging/*`, `desktop/src/pages/Settings.tsx` |
| Implementation | 统一 error code、origin、retry hint、related session/task id；页面可一键复制诊断摘要，不展示底层噪声日志 |
| Existing Libraries | 日志库 |
| Must Self Build | recovery hint model、diagnostic bundle |
| Performance Strategy | 日志分级写入，避免高频 UI 事件刷爆磁盘 |
| Verification | 故障注入、工具失败、MCP 失败、导出失败 |
| Cleanup | 收敛历史散落的错误文案和无结构日志输出 |
| Last Update | 2026-04-23 初始化 |

### WS7 文档与工程治理

#### Goal

保证后续优化可以连续推进，而不是每次进入一个模块都重新摸索架构边界。

#### Task Card: WS7-01

| Field | Detail |
| --- | --- |
| Task | 重要模块补“入口-职责-验证”文档 |
| Status | in_progress |
| Progress | 20% |
| Entry Points | `desktop/docs/*`, 模块旁 `README.md` |
| Implementation | 先覆盖 App Shell、bridge、runtime、manuscripts、video-editor、redclaw、settings；每份文档只保留维护必需信息 |
| Existing Libraries | none |
| Must Self Build | 文档结构与维护纪律 |
| Performance Strategy | 文档不是性能点，但它直接决定回归排查效率 |
| Verification | 新人可根据文档找到入口、边界和验证步骤 |
| Cleanup | 删除过时或重复的历史说明 |
| Last Update | 2026-04-23 初始化 |

#### Task Card: WS7-02

| Field | Detail |
| --- | --- |
| Task | 建立优化任务的验收记录模板 |
| Status | ready |
| Progress | 0% |
| Entry Points | 本文、相关执行计划文档 |
| Implementation | 每项任务完成后必须补：影响范围、验证步骤、结果、残留风险、回滚点 |
| Existing Libraries | none |
| Must Self Build | 验收模板、回写纪律 |
| Performance Strategy | 通过降低返工和排查成本间接提升整体研发效率 |
| Verification | 任一已完成任务都能追溯证据 |
| Cleanup | 删除“已做完但没有记录”的口头知识 |
| Last Update | 2026-04-23 初始化 |

## Update Template

后续每次更新任务时，统一补下面四项：

```md
- status:
- progress:
- last_update:
- evidence:
- cleanup:
- next_step:
```

## Immediate Execution Order

如果从今天开始正式推进，推荐执行顺序如下：

1. `WS1-01` 收敛页面加载与缓存策略
2. `WS1-02` 统一 bridge typed helper 与 fallback contract
3. `WS1-04` workspace hydration 改为最小快照 + 分阶段加载
4. `WS2-01` 收口 context bundle / skills / tools
5. `WS2-06` 重做记忆模块边界与 recall pipeline
6. `WS2-07` 落地记忆 dreaming 自动整理闭环
7. `WS2-08` 简化工具调用复杂度
8. `WS2-02` 收口 approval runtime / tool policy
9. `WS4-01` 收口 manuscript canonical state
10. `WS4-02` 做时间线虚拟化与交互性能治理
11. `WS4-03` 收口预览与导出编排
12. `WS3-04` 建立新闻源接入与时效化知识更新链路
13. `WS4-05` 建立自动剪视频工作流
14. `WS5-01` 统一 RedClaw execution model
15. `WS5-04` 升级统一定时任务平台
16. `WS8-01` 升级 Team 模块为协作控制台
17. `WS8-02` 升级 ACP 协作模块
18. `WS2-05` 内置 vLLM 运行时
19. `WS4-06` 建立 AI 生成动画工作流
20. `WS6-01` 建立统一 diagnostics summary

这个顺序是当前最优解，因为它先解决基础稳定与 AI 可控性，再解决创作主链路，最后补自动化和运维观测。反过来做会导致每个功能线都反复返工。

## Change Rules

- 新任务必须挂到现有工作流；如果现有工作流无法承载，再新增工作流。
- 不允许只写“优化一下”这类抽象任务，必须写清入口、实现方式、验证和收尾。
- 完成任务时必须同步更新进度和 cleanup，不允许只改状态不留证据。
- 如果任务影响 IPC、runtime contract、workspace schema 或视频导出协议，必须同步补相关文档。
- `done` 任务在完成当天写入 `desktop/docs/archive/` 并加上 `last_update`、`evidence`、`cleanup`、`risks` 记录。

## Verification

最低验证要求沿用仓库规范，并按工作流补充：

- 改页面：切换、刷新、失败保留旧数据
- 改 bridge / IPC / host：至少从真实页面走一遍
- 改 AI runtime / tools / prompt：至少跑一轮真实任务，检查事件流、工具调用、审批、最终摘要
- 改视频链路：至少验证编辑、预览、导出三段
- 改 RedClaw / scheduler：验证定时、执行、失败恢复、本地时区

## Related Files

- [desktop/docs/architecture/system-overview.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/architecture/system-overview.md)
- [desktop/docs/architecture/product-module-breakdown.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/architecture/product-module-breakdown.md)
- [desktop/docs/ai-runtime-maintenance-overview.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/ai-runtime-maintenance-overview.md)
- [desktop/docs/runtime-optimization-test-plan.md](/Users/Jam/LocalDev/GitHub/RedConvert/desktop/docs/runtime-optimization-test-plan.md)
