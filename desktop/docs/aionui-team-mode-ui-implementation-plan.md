---
doc_type: plan
execution_status: in_progress
last_updated: 2026-05-02
owner: codex
scope:
  - desktop/src/pages/Team.tsx
  - desktop/src/pages/Chat.tsx
  - desktop/src/components/ChatComposer.tsx
  - desktop/src/components/MessageItem.tsx
  - desktop/src/bridge/ipcRenderer.ts
  - desktop/src-tauri/src/runtime/collab_runtime.rs
  - desktop/src-tauri/src/commands/runtime_collab.rs
  - desktop/src-tauri/src/mcp/team_server.rs
  - desktop/src-tauri/src/subagents/team_tools.rs
reference_implementations:
  - /Users/Jam/LocalDev/GitHub/AionUi/src/renderer/pages/team/TeamPage.tsx
  - /Users/Jam/LocalDev/GitHub/AionUi/src/renderer/pages/team/components/TeamChatView.tsx
  - /Users/Jam/LocalDev/GitHub/AionUi/src/renderer/pages/team/components/TeamTabs.tsx
  - /Users/Jam/LocalDev/GitHub/AionUi/src/renderer/pages/team/hooks/TeamTabsContext.tsx
  - /Users/Jam/LocalDev/GitHub/AionUi/src/process/team/TeamSession.ts
  - /Users/Jam/LocalDev/GitHub/AionUi/src/process/team/TeamSessionService.ts
  - /Users/Jam/LocalDev/GitHub/AionUi/src/process/team/TeammateManager.ts
  - /Users/Jam/LocalDev/GitHub/AionUi/src/process/team/mcp/team/TeamMcpServer.ts
success_metrics:
  - team_mode_first_paint_without_awaited_runtime = true
  - chat_component_reuse_rate >= 80 percent
  - active_agent_slot_unrelated_rerenders_per_chunk = 0
  - stale_snapshot_preserved_on_refresh_failure = true
  - team_runtime_event_recovery_after_reload = true
  - video_task_artifact_visibility = 100 percent
---

# AionUi-Inspired Team Mode UI Implementation Plan

## 1. 研究结论

AionUi team 模式值得学习的不是视觉皮肤，而是产品结构：

```text
左侧团队入口
-> 中间横向 agent workbench
-> 顶部 agent tab/status
-> 每个 agent slot 内复用成熟单聊组件
-> 后端用 mailbox/task/MCP tools 协调 agent
```

它的 UI 成功点很明确：

- 每个 agent 是一个独立聊天槽位，不把所有内容混进一个群聊时间线。
- 顶部 tab 只显示成员身份、运行状态、待处理权限，不解释系统机制。
- 横向并排让用户能同时观察多个 agent；agent 多时自然横向滚动。
- 单个 slot 内直接复用已有平台聊天组件，避免重写消息流、工具事件、权限确认、输入框。
- leader 是固定第一成员，其他成员可横向排列、聚焦、全屏。

RedConvert 最优路线：

```text
不搬 AionUi 代码
不重做聊天组件
不新增一套复杂群聊 UI

在现有 Team 页面里新增 AionUi 式 Team Workbench，
把现有 teamRuntime/collab_runtime 作为数据与执行底座，
把 Chat.tsx 拆出可嵌入的 AgentChatPanel 能力复用。
```

## 2. 当前 RedConvert 可复用资产

### 2.1 UI

- `desktop/src/pages/Team.tsx` 已有团队侧栏、群聊和成员入口，可作为 team mode 入口外壳。
- `desktop/src/pages/Chat.tsx` 已有成熟消息列表、runtime stream 处理、工具确认、附件、知识库引用、成员 mention、音频输入、上下文用量和 dispatch override。
- `desktop/src/components/MessageItem.tsx` 已支持流式 markdown、工具 timeline、thinking、计划、附件和成员身份展示。
- `desktop/src/components/ChatComposer.tsx` 已支持模型选择、附件、音频、成员/知识库 mention、busy/cancel 状态。

### 2.2 Runtime

- `desktop/src/bridge/ipcRenderer.ts` 已有 `teamRuntime` / `collab` facade。
- `desktop/src-tauri/src/runtime/collab_runtime.rs` 已有 `CollabSessionRecord`、`CollabMemberRecord`、`CollabTaskRecord`、mailbox、reports、review dockets、TTL 清理。
- `desktop/src-tauri/src/commands/runtime_collab.rs` 已有 `team-runtime:*` IPC 分发和 `runtime:collab-*` 事件。
- `desktop/src-tauri/src/mcp/team_server.rs` 已有 schema-first MCP contract：`team_send_message`、`team_list_members`、`team_update_work_item`、`team_submit_report` 等。
- `desktop/src-tauri/src/subagents/team_tools.rs` 已有 team tool action 执行面，符合仓库要求的收敛工具面。

## 3. 推荐产品架构

```text
TeamPage
├─ TeamSidebar
│  ├─ Team Sessions
│  ├─ Existing CreativeChat Rooms
│  └─ Members / Advisors
├─ TeamWorkbench
│  ├─ TeamHeader
│  ├─ TeamAgentTabs
│  ├─ HorizontalAgentCanvas
│  │  ├─ AgentChatSlot(leader)
│  │  ├─ AgentChatSlot(member)
│  │  └─ AgentChatSlot(member...)
│  └─ optional AgentFocusMode
├─ TeamTaskDrawer
│  ├─ Tasks
│  ├─ Reports
│  ├─ Review Dockets
│  └─ Artifacts
└─ TeamRuntimeProvider
   ├─ snapshot hydrate
   ├─ runtime:event subscription
   ├─ stale snapshot cache
   └─ optimistic status map
```

### 3.1 关键产品原则

- 首屏优先展示 workbench shell 和最后一次成功 snapshot，不等 runtime 激活。
- 每个 agent slot 是一个独立会话视窗，不在主页面堆解释文字。
- UI 只展示可决策状态：运行中、等待、失败、待确认、完成。
- 复杂任务状态放进右侧/抽屉，不塞进每个 slot。
- 用户对某个 agent 发消息时走 `team-runtime:send-message`，不是直接绕到普通 `chat:send-message`。
- agent 自己的长链路仍然由现有 runtime / subagents / MCP tools 完成。

## 4. UI 实现细节

### 4.1 新增模块

```text
desktop/src/pages/team-workbench/
├─ TeamWorkbench.tsx
├─ TeamRuntimeProvider.tsx
├─ TeamAgentTabs.tsx
├─ AgentChatSlot.tsx
├─ AgentChatPanel.tsx
├─ TeamTaskDrawer.tsx
├─ teamWorkbenchTypes.ts
└─ teamWorkbenchUtils.ts
```

`Team.tsx` 只负责选择当前 section/session，把选中的 `collabSessionId` 交给 `TeamWorkbench`。不要继续把复杂逻辑堆进 `Team.tsx`。

### 4.2 AgentChatPanel 复用方案

从 `Chat.tsx` 提取或包装一个嵌入式聊天面板：

```tsx
type AgentChatPanelProps = {
  sessionId: string;
  memberId: string;
  memberName: string;
  memberAvatar?: string;
  teamSessionId: string;
  embedded?: true;
  showSidebar?: false;
  showHeader?: false;
  showClearButton?: false;
  contentLayout?: 'wide';
  placeholder?: string;
  onDispatchOverride: ChatDispatchOverride;
};
```

实现方式：

- 第一步优先包装现有 `Chat`，使用已有 `fixedSessionId`、`fixedMemberMention`、`onDispatchOverride`、`embeddedTheme`、`showWelcomeHeader=false`、`contentLayout='wide'`。
- 若包装后 props 过重，再把 `ChatMessageList`、`ChatInputDock`、`useChatRuntimeStream` 从 `Chat.tsx` 抽出。抽取必须保持行为不变。
- `AgentChatSlot` 不直接处理 markdown、工具事件、附件、输入框；这些全部交给现有组件。

### 4.3 横向布局

推荐布局：

```tsx
<div className="flex h-full min-h-0 flex-col">
  <TeamAgentTabs />
  <div className="relative min-h-0 flex-1 overflow-hidden">
    <div className="flex h-full overflow-x-auto overflow-y-hidden">
      {members.map(member => (
        <AgentChatSlot
          key={member.id}
          style={{ flex: '1 1 420px', minWidth: members.length <= 2 ? 320 : 420 }}
        />
      ))}
    </div>
  </div>
</div>
```

交互：

- leader 固定第一列，左边加 3px accent border。
- tab 点击滚动到对应 slot。
- slot header 只放身份、状态、模型/后端、关闭或全屏图标。
- agent 超过可视宽度时显示左右渐隐箭头。
- 全屏模式只渲染一个 slot，保留顶部 tab。
- 不做卡片套卡片；slot 是列，不是装饰卡。

### 4.4 Tab 状态

`TeamAgentTabs` 使用本地 context：

```ts
type TeamTabsState = {
  members: CollabMemberView[];
  activeMemberId: string;
  statusMap: Map<string, MemberRuntimeStatus>;
  pendingApprovalCounts: Map<string, number>;
  switchMember(memberId: string): void;
  reorderMembers(fromId: string, toId: string): void;
};
```

实现规则：

- leader 永远排第一，不可拖拽。
- 成员顺序存 `localStorage["redbox:team-member-order:<sessionId>"]`。
- active member 存 `localStorage["redbox:team-active-member:<sessionId>"]`。
- statusMap 只被 runtime events 增量更新；snapshot 刷新只修正缺失或终态。

## 5. AI 协作实现

### 5.1 运行时模型

复用现有 RedConvert teamRuntime，不照搬 AionUi 的 Electron process/team：

```text
CollabSessionRecord = team session
CollabMemberRecord = agent slot
CollabTaskRecord = task board item
CollabMailboxMessageRecord = agent mailbox / visible team message
CollabProgressReportRecord = progress / artifact / blocker
ReviewDocketRecord = human review gate
runtime:event = UI invalidation + optimistic update signal
```

### 5.2 Leader 与 Member

必须自研：

- leader prompt overlay：负责拆解、分配、验收、最终汇总。
- member prompt overlay：负责读 mailbox、执行任务、汇报证据、停止空转。
- scheduler policy：决定何时唤醒 leader、何时请求 report、何时判定 stuck。
- artifact evidence gate：完成任务必须带文件、报告、截图或可验证证据。

必须用现成能力：

- LLM 调用、工具执行、runtime stream：复用现有 `agent_engine` / `subagents` / `interactive_runtime_shared`。
- MCP schema：复用 `desktop/src-tauri/src/mcp/team_server.rs`，只补缺失 contract。
- 数据持久化：复用 `AppStore` 和已有 `collab_runtime` 记录，不新增 SQLite 表。

### 5.3 消息发送路径

用户在某个 agent slot 输入：

```text
ChatComposer
-> AgentChatPanel.onDispatchOverride
-> window.ipcRenderer.teamRuntime.sendMessage({
     sessionId,
     fromMemberId: "user",
     toMemberId: memberId,
     body,
     attachments,
     knowledgeRefs,
   })
-> collab_runtime::post_collab_message
-> runtime event
-> scheduler wake target member
```

agent 给其他 agent 发消息：

```text
MCP team_send_message
-> execute_team_mcp_tool
-> execute_team_tool("team.message.send")
-> CollabMailboxMessageRecord
-> runtime:collab-message-changed
-> UI slot update + target wake
```

### 5.4 完成判定

不能只信 agent 文本“完成了”。完成任务需要：

- `team_submit_report` 的 `reportType=completion`。
- `team_update_work_item` 把任务置为 `completed`。
- 至少一个 evidence：artifact id、文件路径、测试输出、渲染预览、外部链接或明确检查结果。
- reviewer 或 leader 对高风险任务生成 `ReviewDocketRecord`。

## 6. 视频处理实现

Team mode 必须支持 RedConvert 的视频/媒体任务，而不是只做代码协作。

### 6.1 视频任务类型

```text
video.transcript      -> 提取/校准字幕
video.segment         -> 分镜/镜头切分
video.script          -> 口播/短视频脚本
video.asset           -> 素材检索/整理
video.edit-plan       -> 时间线规划
video.render          -> Remotion/导出任务
video.qa              -> 成片检查
```

### 6.2 库选择

必须用现成库：

- `mediabunny`：浏览器端/TS 侧媒体解析、轻量元信息和可视化辅助。
- `@remotion/*` / `remotion`：程序化视频渲染与预览。
- `wavesurfer.js`：音频波形、片段定位。
- Tauri/Rust command + ffmpeg/系统工具：长耗时转码、抽帧、合成、探测应放 host 侧或子进程。

需要自研：

- `TeamVideoArtifactRegistry`：把视频任务产物挂到 `CollabProgressReportRecord.artifacts`。
- `VideoTaskPlanner` prompt：把用户目标拆成 transcript/segment/script/render/qa 任务。
- `VideoSlotPreview`：在 `TeamTaskDrawer` 或 slot 附件里显示关键帧、片段、渲染状态。
- `render job -> artifact -> review docket` 的状态桥接。

### 6.3 视频任务流

```text
用户提交视频/链接/素材
-> leader 创建 video.* task graph
-> researcher/transcriber 处理 transcript
-> editor/copywriter 处理 script
-> animation-director 处理 edit-plan
-> renderer 执行 remotion/ffmpeg job
-> reviewer 检查时长、字幕、画面、导出文件
-> leader 汇总交付
```

UI 不新增复杂说明。只在 task drawer 显示：

- 任务状态。
- 当前处理的文件/片段。
- 关键 artifact。
- 失败原因和重试按钮。

## 7. 现成库 vs 自研边界

| 模块 | 方案 | 原因 |
| --- | --- | --- |
| 聊天消息渲染 | 复用 `MessageItem` | 已支持流式、工具、附件、计划、成员身份 |
| 输入框 | 复用 `ChatComposer` | 已支持模型、附件、语音、mention |
| 横向 workbench | 自研 | 这是产品特定布局，AionUi 只作参考 |
| tab/context 状态 | 自研轻量 context | 与 RedConvert session/member 数据绑定 |
| query/cache | 暂不引入 SWR/TanStack | 当前项目未使用，先用 hook + stale snapshot，避免新依赖 |
| 拖拽排序 | 先用原生 drag/drop | 成员排序简单；复杂 kanban 再考虑 dnd-kit |
| 可调整分栏 | 可用 `react-resizable-panels` | 项目已依赖，适合 task drawer/preview |
| Markdown | 复用 `StreamingMarkdown` / `react-markdown` | 已成熟 |
| 视频解析/渲染 | 复用 `mediabunny`、Remotion、ffmpeg | 视频底层不要自研 |
| AI 调度 | 自研在 collab runtime 上 | 需要贴合 RedConvert 工具、权限、artifact、review |
| MCP transport/schema | 复用并扩展现有 `team_server.rs` | 已符合 schema-first tool contract |

## 8. 方案对比

| 方案 | 描述 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A. 完全复制 AionUi team | 搬 process/team + React 页面 | 短期看起来快 | Electron/Arco/SWR/ACP 假设不适配 Tauri；会绕过现有 runtime | 不推荐 |
| B. 保留现有群聊，只加状态面板 | 在 CreativeChat 上叠任务/成员状态 | 改动小 | 仍然看不到每个 agent 的独立执行流；用户喜欢的并排体验没有出现 | 不推荐 |
| C. AionUi 式 workbench + RedConvert runtime | UI 学 AionUi，后端复用 collab_runtime，聊天复用 Chat | 体验匹配、架构最稳、少造轮子 | 需要抽一层嵌入式 Chat panel | 推荐 |
| D. 新建完整 Team IDE | 独立页面、独立消息组件、独立任务板 | 可控 | 工作量大，重复成熟聊天链路，风险最高 | 不推荐 |

推荐方案 C。

## 9. 性能策略

### 9.1 首屏

- TeamWorkbench 首屏只读 `team-runtime:get-session({ mailboxLimit: 40, reportLimit: 30 })`。
- 如果已有本地 snapshot，先渲染，再后台刷新。
- 失败时保留旧 snapshot，并在 header 用小型错误状态提示。
- 不在页面 mount 时启动所有 agent；只确保 session record 可读。

### 9.2 Streaming

- 不订阅未消费的高频 message stream。
- `runtime:event` 只作为 invalidation 或小范围 optimistic patch。
- 每个 `AgentChatSlot` 用 `React.memo`，props 保持稳定。
- `TeamTabsContext` value 必须 `useMemo`。
- 自动滚动用 `requestAnimationFrame` 合并，依赖 message count/stream token version，不在每个 chunk 强制读写 layout。

### 9.3 横向面板

- slot 最小宽度 420px，成员多时横向滚动，不压缩到不可读。
- 只渲染可见 slot 附近内容：第一版可全部渲染，超过 6 个成员后启用轻量 virtualization。
- 全屏模式只挂载当前 slot 的重消息列表，其他 slot 保留状态不渲染消息 DOM。

### 9.4 Host

- `get-session` 返回 summary，不返回无限消息。
- mailbox read TTL 沿用 `COLLAB_MAILBOX_READ_TTL_MS`，已读消息定期清理。
- 不持锁做文件 I/O、视频探测、渲染、workspace hydration。
- 视频/大文件处理必须后台 job 化，UI 通过 artifact/report 轮廓渐进更新。

## 10. 执行清单

### Commit 1: 文档和类型

- 新增本计划。
- 补 `TeamWorkbench` 所需 TS 类型：`CollabSessionView`、`CollabMemberView`、`MemberRuntimeStatus`、`TeamWorkbenchSnapshot`。
- 不改 UI 行为。

### Commit 2: Embedded Chat Panel

- 从 `Chat.tsx` 抽出或包装 `AgentChatPanel`。
- 保持现有 Chat 页面视觉与行为不变。
- 为 `onDispatchOverride` 增加 team member 场景的最小示例。

验证：

- 普通 Chat 新建/发送/流式/工具确认不变。
- fixedSessionId 嵌入模式能显示历史消息。

### Commit 3: TeamRuntimeProvider

- 新增 snapshot hook。
- 订阅 `runtime:event` 中的 `runtime:collab-session-changed`、`runtime:collab-member-changed`、`runtime:collab-task-changed`、`runtime:collab-message-changed`。
- 实现 stale-while-revalidate。

验证：

- 刷新失败保留上次数据。
- task/member 事件能更新对应 session。

### Commit 4: TeamAgentTabs + AgentChatSlot

- 实现顶部 tab、状态 badge、横向 slot、滚动箭头、全屏。
- leader 固定第一列。
- 使用 `AgentChatPanel` 渲染每个成员。

验证：

- 1/2/5 个成员布局不溢出。
- tab 点击能定位 slot。
- active member 持久化。

### Commit 5: Team Page 接入

- `Team.tsx` 增加 `team-workbench` section 或把群聊 section 升级为 workbench。
- 左侧新增 team session 列表，保留现有群聊/成员入口。
- 创建 team session 后自动打开 workbench。

验证：

- 页面切换不卸载运行中的 workbench。
- 原 CreativeChat 和 Advisors 可继续使用。

### Commit 6: Team Message Dispatch

- `AgentChatPanel.onDispatchOverride` 调 `teamRuntime.sendMessage`。
- user message 乐观写入当前 slot。
- target member wake 由 runtime/scheduler 负责。

验证：

- 对 leader 发消息能进入 mailbox。
- 对 member 发消息能进入对应 slot。
- 失败时 placeholder 显示内联错误，不清空历史。

### Commit 7: Task Drawer + Video Artifacts

- 新增 `TeamTaskDrawer`，展示 task/report/review/artifact。
- 视频 artifact 显示缩略图、文件名、时长、状态、打开/预览动作。
- 不在 slot 内塞复杂任务说明。

验证：

- video.* 任务产物能被看见。
- 大 artifact 列表分页或 limit。

### Commit 8: Runtime 缺口补齐

- 若现有 `collab_runtime` 缺少 `runtime:collab-message-changed`，补事件。
- 若缺少 member status 粒度，补 `status/lastActivityAt/currentTaskId`。
- 补 agent wake/retry 的 narrow IPC/action，不新增顶层工具。

验证：

- `pnpm ipc:inventory`。
- `cd desktop/src-tauri && cargo fmt --check && cargo check`。

### Commit 9: Performance Hardening

- memoize slot/tab/context。
- RAF 合并自动滚动。
- slot 数量超过阈值时启用懒渲染。
- 增加 mailbox/report limit 参数默认值。

验证：

- 3 个 agent 同时 streaming 时无无关 slot 跟随重渲染。
- 横向滚动和输入不卡顿。

### Commit 10: End-to-End Verification

- 跑一个真实 team 任务：leader 拆任务，member 汇报，leader 汇总。
- 跑一个视频素材任务：产生 transcript/script/render 或 QA artifact。
- 检查 `~/Library/Application Support/RedBox/session-transcripts/`、`session-bundles/`、状态库。

验证命令：

```bash
cd desktop
pnpm build
pnpm ipc:inventory
cd src-tauri
cargo fmt --check
cargo check
```

## 11. 完成标准

- 用户打开 Team 后，默认看到可工作的并排 agent workbench，而不是抽象团队说明。
- 每个 agent slot 的消息、工具、附件、权限和输入体验复用现有 Chat 能力。
- teamRuntime 是唯一协作事实源，UI 不维护私有真相。
- AI 协作通过 schema-first team tools 进行，不靠解析自然语言关键词。
- 视频任务产物能从 task/report/artifact 链路被追踪和预览。
- 刷新、切页、失败、重启后都能恢复最后成功状态。
