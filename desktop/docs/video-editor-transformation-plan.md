# RedBox 视频编辑器改造计划

更新时间：2026-04-10

## 目标

在保持 RedBox 当前三栏布局不变的前提下，把视频稿件编辑页升级为一个更接近成熟编辑器的系统：

- 左侧：素材与工程资源
- 中间：预览 / Remotion 场景 / 脚本
- 底部：真正可编辑的时间轴
- 右侧：RedClaw 剪辑助手

同时满足一个硬约束：

**所有视频编辑能力都必须既能由用户直接操作，也能由 AI 通过统一工具调用驱动。**

这意味着视频编辑器不是一组 UI 组件，而是一个有明确真相层、事件层、工具层的数据系统。

---

## 参考项目的核心结论

参考代码库：`/Users/Jam/LocalDev/GitHub/react-video-editor`

结论不是“把它的页面照搬过来”，而是学习它的五层骨架。

### 1. 编辑器 Shell

关键文件：

- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/features/editor/editor.tsx`

它的编辑器不是一页普通表单，而是一个明确的组合：

- `Navbar`
- `Sidebar`
- `Scene`
- `Timeline`
- `FloatingControl`
- `ResizablePanelGroup`

值钱的点：

- 时间轴是独立的大模块，不是预览区的附属组件
- 预览区与时间轴共享同一状态源
- 控制面板是基于“选中项”动态切换，而不是写死一堆按钮

### 2. Timeline 内核

关键文件：

- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/features/editor/timeline/timeline.tsx`
- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/features/editor/timeline/header.tsx`
- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/features/editor/timeline/ruler.tsx`
- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/features/editor/timeline/items/timeline.ts`

它真正有价值的不是视觉，而是内部职责拆分：

- `header`：播放、缩放、删除、切割、时间显示
- `ruler`：刻度、拖拽滚动、点击定位
- `playhead`：当前播放头
- `canvas timeline`：轨道与片段
- `horizontal scrollbar`：独立同步滚动

值钱的点：

- 时间轴不是一个黑盒库直接 render 完，而是被拆成头部、标尺、内容、滚动层
- 时间轴滚动与播放器时间同步是正式能力，不是顺手加的逻辑
- 缩放、播放头、轨道交互属于同一个状态域

### 3. Scene / Player 联动

关键文件：

- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/features/editor/scene/scene.tsx`
- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/features/editor/player/player.tsx`
- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/features/editor/player/composition.tsx`
- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/features/editor/scene/interactions.tsx`

值钱的点：

- Scene 区不是一个普通预览框，而是“可选中、可拖拽、可编辑”的场景板
- 播放器只负责播放，Composition 才负责把 track items 渲染成最终视觉
- 选中对象、当前时间、播放器 seek、文本编辑都被纳入统一状态/事件系统

### 4. 状态层

关键文件：

- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/features/editor/store/use-store.ts`
- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/features/editor/hooks/use-state-manager-events.ts`
- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/features/editor/hooks/use-timeline-events.ts`

值钱的点：

- 播放器、时间轴、场景、选中态，共享一个 store
- 各模块不直接互调，而是通过事件和 store 同步
- “当前工程真相”只有一份

### 5. 导出链

关键文件：

- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/app/api/render/route.ts`
- `/Users/Jam/LocalDev/GitHub/react-video-editor/src/app/api/render/[id]/route.ts`

结论：

- 它把导出视作独立 pipeline，而不是“时间轴组件顺手点个按钮”
- 导出状态、轮询、结果是正式流程

---

## RedBox 当前现状

当前 RedBox 视频编辑器相关代码：

- `/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/components/manuscripts/VideoDraftWorkbench.tsx`
- `/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/components/manuscripts/EditableTrackTimeline.tsx`
- `/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/components/manuscripts/remotion/RemotionVideoPreview.tsx`
- `/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src/components/manuscripts/remotion/RemotionTransportBar.tsx`

当前宿主与 AI 工具链：

- `/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/catalog.rs`
- `/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/tools/packs.rs`
- `/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/main.rs`
- `/Users/Jam/LocalDev/GitHub/RedConvert/desktop/src-tauri/src/commands/manuscripts.rs`

当前已经具备：

- 三栏布局基本成立
- 预览与 Remotion 预览已接入
- 底部时间轴已有基础轨道编辑
- 已有 `redbox_editor` 工具
- AI 已可调用：
  - `timeline_read`
  - `track_add`
  - `clip_add`
  - `clip_update`
  - `clip_delete`
  - `clip_split`
  - `remotion_generate`
  - `remotion_save`
  - `export`

当前主要缺口：

### 1. 缺统一编辑器真相层

现在仍然更接近“多个组件各自持有局部状态”：

- 预览时间
- 时间轴游标
- 选中片段
- Remotion 场景选中
- 工程 timeline summary

这些虽然开始联动，但还没有一个正式的 editor store。

### 2. 时间轴还是“库组件包装层”

当前 `EditableTrackTimeline` 已经比之前好很多，但仍然没有完全形成：

- header
- ruler
- playhead
- canvas
- scrollbar

这套明确结构。

### 3. Scene 编辑层很弱

现在 Remotion 场景更多是“生成并预览”，不是“真正可视化编辑”：

- 缺对象级选中
- 缺舞台内拖拽
- 缺 overlay / text / caption 的视觉编辑器
- 缺场景板与时间轴片段的深度联动

### 4. AI 工具还停留在“clip 级 CRUD”

当前 `redbox_editor` 很重要，但还不够成熟。

现在主要是：

- 读 timeline
- 加删改 clip
- 增加轨道
- 切割
- 生成 / 保存 Remotion scene
- 导出

还缺：

- 选中状态读取
- 播放头控制
- 片段范围查询
- 在当前播放头插入
- 定位到片段
- 批量操作
- 片段移动 / 替换 / ripple 行为
- 场景对象级编辑

### 5. 编辑器事件流还不够正式

目前前端和 AI 虽然都能改工程，但还没有把“编辑器事件”升格成统一 runtime 事件。

应该补齐的事件至少包括：

- `editor.timeline_changed`
- `editor.selection_changed`
- `editor.playhead_changed`
- `editor.asset_inserted`
- `editor.track_added`
- `editor.export_started`
- `editor.export_progress`
- `editor.export_finished`
- `editor.scene_changed`

---

## 改造原则

### 原则 1：不照搬页面，照搬骨架

不能把参考项目整套 UI 生搬进来。

应该学习并重建的是：

- store 结构
- timeline 分层
- scene/player 联动方式
- interaction model
- export pipeline 思维

### 原则 2：布局稳定，内核升级

保留当前 RedBox 的页面布局：

- 左素材
- 中预览
- 底时间轴
- 右 AI

改造重点放在：

- 编辑器内核
- 状态层
- AI 工具层
- 事件层

### 原则 3：用户操作与 AI 工具调用必须改同一份真相

用户拖拽片段，和 AI 调用 `clip_update`，最终都必须改同一个工程状态。

不允许出现：

- 前端改了本地 state，但宿主没变
- AI 改了 package state，但前端内部 state 没跟上

### 原则 4：所有耗时操作都后台化

包括：

- 导出
- 转场生成
- 字幕生成
- Remotion render
- AI 剪辑轮次

这些都不能阻塞 UI。

---

## 目标架构

### 一层：工程真相层

建议新增一个正式的 editor state model，前端只消费它，宿主持久化它。

建议结构：

```ts
type EditorProjectState = {
  filePath: string;
  mediaAssets: EditorAsset[];
  timeline: TimelineState;
  selection: EditorSelectionState;
  playhead: EditorPlayheadState;
  viewport: EditorViewportState;
  remotion: RemotionSceneState;
  exportState: EditorExportState;
  revision: number;
};
```

重点：

- `timeline` 是时间轴真相
- `selection` 是选中真相
- `playhead` 是播放头真相
- `remotion` 是动画场景真相

### 二层：前端编辑器 store

建议新增：

- `src/features/video-editor/store/useVideoEditorStore.ts`

职责：

- 接宿主 `package state`
- 接收 runtime/editor 事件
- 给 UI 提供统一 selector
- 提供用户本地交互 action

### 三层：宿主编辑器命令层

保留 `redbox_editor` 作为统一入口，但要扩展成正式的编辑器协议。

建议动作分组：

#### 读取类

- `timeline_read`
- `selection_read`
- `playhead_read`
- `scene_read`
- `assets_read`

#### 时间轴写入类

- `track_add`
- `track_delete`
- `track_rename`
- `clip_add`
- `clip_insert_at_playhead`
- `clip_move`
- `clip_reorder`
- `clip_update`
- `clip_delete`
- `clip_split`
- `clip_trim`
- `clip_toggle`
- `clip_replace_asset`

#### 播放控制类

- `playhead_seek`
- `play`
- `pause`
- `selection_set`
- `focus_clip`

#### Remotion / 场景类

- `remotion_generate`
- `remotion_read`
- `remotion_save`
- `scene_update`
- `overlay_add`
- `overlay_update`
- `overlay_delete`

#### 导出类

- `export`
- `export_status`
- `export_cancel`

### 四层：统一事件流

所有编辑器变化都通过统一 runtime 事件广播。

建议事件 pack：

```text
runtime:event
  -> editor.project_loaded
  -> editor.timeline_changed
  -> editor.selection_changed
  -> editor.playhead_changed
  -> editor.scene_changed
  -> editor.export_started
  -> editor.export_progress
  -> editor.export_finished
  -> editor.error
```

前端必须只消费这些事件，不直接耦合某条历史 IPC 回调。

---

## 分阶段改造计划

## 阶段 0：定边界，冻结现有行为

目标：

- 不再继续临时堆按钮和局部状态
- 先把视频编辑器的真相层边界定下来

工作：

- 梳理当前 `VideoDraftWorkbench` 的状态来源
- 梳理当前 `EditableTrackTimeline` 的状态来源
- 梳理 `manuscripts:get-package-state` 返回结构
- 明确哪些字段属于：
  - 时间轴真相
  - 播放头真相
  - 选中态真相
  - Remotion 真相

完成标准：

- 有正式的 editor state schema 文档
- 不再新增绕开宿主真相层的局部编辑状态

---

## 阶段 1：抽出正式的 Video Editor Store

目标：

- 把视频编辑器从“组件拼接”升级为“编辑器状态系统”

工作：

- 新建 `useVideoEditorStore`
- 把下列状态集中进去：
  - current asset
  - selected clip
  - cursor/playhead
  - viewport scroll/zoom
  - remotion selected scene
  - export state
- `VideoDraftWorkbench` 和 `EditableTrackTimeline` 只做视图层

完成标准：

- 预览、时间轴、右侧 AI 都从同一 store 取当前工程态
- 不再各自维护互相复制的 state

---

## 阶段 2：按参考项目拆时间轴骨架

目标：

- 让底部时间轴具备成熟编辑器结构

工作：

- 从当前 `EditableTrackTimeline` 拆出：
  - `TimelineHeader`
  - `TimelineRuler`
  - `TimelineCanvas`
  - `TimelineScrollbar`
  - `PlayheadIndicator`
- 增加：
  - fit zoom
  - 缩放级别切换
  - 当前时间 / 总时长 / 当前帧
  - 播放头居中聚焦
  - 跳到片段起点 / 终点

完成标准：

- 时间轴头、标尺、内容、滚动条职责清晰
- 横向滚动、缩放、游标联动稳定

---

## 阶段 3：把素材插入/拖拽做成正式能力

目标：

- 素材进入时间轴不再是“加一个按钮”，而是正式编辑器行为

工作：

- 支持：
  - 点击 `+` 追加到末尾
  - 拖到轨道空位插入
  - 拖到片段中间先 split 再插入
  - 拖到不同轨道按类型自动纠正
- 增加可视化 drop target 提示
- 增加素材插入事件

完成标准：

- 用户从左侧素材到时间轴的所有核心动作稳定
- AI 与用户插入逻辑共用同一宿主命令

---

## 阶段 4：补 Scene 编辑层

目标：

- 把 Remotion 从“生成结果预览”升级为“可编辑动画场景板”

工作：

- 在中间 `motion` 视图补：
  - overlay 选中
  - 拖拽定位
  - 文本编辑
  - 字幕块编辑
  - 入场/出场动画选择
- 增加 scene item selection state
- 场景修改后写回统一 `remotion` 真相

完成标准：

- 可以直接在场景板里调整主要文本/字幕/overlay
- AI 工具与用户拖拽修改的是同一份 scene state

---

## 阶段 5：升级 AI 编辑器工具契约

目标：

- 让 AI 真正能“像编辑器用户一样工作”

工作：

- 扩展 `redbox_editor` 工具 schema
- 增加：
  - `selection_read`
  - `playhead_read`
  - `playhead_seek`
  - `selection_set`
  - `focus_clip`
  - `clip_insert_at_playhead`
  - `clip_move`
  - `clip_trim`
  - `scene_update`
  - `export_status`
- 让 tool result 返回更强结构化信息：
  - revision
  - changed entities
  - timeline summary
  - selection summary
  - playhead summary

完成标准：

- AI 可以先读当前工程态，再按步骤修改
- AI 能明确知道自己修改后的结果
- 用户与 AI 永远共享同一份工程真相

---

## 阶段 6：编辑器事件流正式化

目标：

- 彻底做到前后端解耦

工作：

- 把编辑器所有变更收口到统一 `runtime:event`
- 新增 editor 事件 pack
- 前端 store 只消费事件，不直接依赖某个历史 IPC 副作用
- AI 执行链也通过同一事件流把“正在读取时间线 / 正在切割 / 正在导出”推给前端

完成标准：

- 切换页面不会中断后台编辑 / 导出 / AI 剪辑
- 返回页面后，store 可从事件 + state 恢复一致状态

---

## 阶段 7：导出链独立化

目标：

- 导出成为正式后台任务

工作：

- `export` 改成后台任务
- 增加：
  - `export_status`
  - `export_cancel`
  - `export_open_output`
- 前端显示导出进度、结果、失败原因
- AI 也可以查询导出状态

完成标准：

- 导出不阻塞 UI
- AI 和用户都可以看到导出进度

---

## 阶段 8：高级编辑能力

这是第二波，不要抢在前面做。

包括：

- transition lane
- ripple delete / insert
- clip clone
- caption track
- waveform / filmstrip
- scene template
- transition preset
- subtitle timing panel

这一阶段是“增强编辑器”，不是“把编辑器做成可用”的前置条件。

---

## AI 工具调用的硬要求

这是本次改造里最重要的部分。

## 1. AI 不能修改前端局部 state

AI 只能通过 `redbox_editor` 调工具。

不能：

- 直接依赖前端内部变量
- 直接改 React 组件状态
- 假设当前 UI 就是真相

## 2. AI 必须先读后写

建议规则：

- 先 `timeline_read`
- 需要时 `selection_read` / `playhead_read`
- 再执行 `clip_* / track_* / scene_*`
- 最后读一次确认结果

## 3. AI 工具结果必须结构化

不要只返回 `success: true`。

至少返回：

```json
{
  "success": true,
  "revision": 42,
  "timelineSummary": {},
  "selection": {},
  "playhead": {},
  "changed": {
    "tracks": ["V1"],
    "clips": ["clip-1", "clip-2"]
  }
}
```

## 4. AI 执行过程必须可见

编辑器内右侧聊天区要能显示：

- 读了哪些工程信息
- 调了哪些编辑工具
- 修改了哪些轨道/片段
- 导出是否成功

这要求编辑器工具调用链必须发统一事件。

---

## 不建议直接照抄的部分

### 1. 不照搬 DesignCombo 状态系统

参考项目使用：

- `@designcombo/state`
- `@designcombo/events`
- `@designcombo/timeline`

这些可以学习设计，不建议直接作为 RedBox 核心依赖。

原因：

- 会把 RedBox 工程真相再次绑定到外部库模型
- 不利于 Rust 宿主与 AI 工具层统一
- 未来难以保证跨平台和宿主控制力

### 2. 不照搬它的业务 UI

例如：

- 顶栏结构
- Sidebar 目录
- 模板/字体/素材面板

这些与 RedBox 的产品结构不一致。

---

## 推荐执行顺序

1. 阶段 0：整理 editor 真相层边界
2. 阶段 1：抽出 `useVideoEditorStore`
3. 阶段 2：拆 timeline 骨架
4. 阶段 3：补插入/拖拽/落点模型
5. 阶段 5：先升级 `redbox_editor` 工具契约
6. 阶段 6：编辑器事件流正式化
7. 阶段 4：Scene 编辑层
8. 阶段 7：导出后台化
9. 阶段 8：高级能力

注意：

**AI 工具层不要放到最后。**

因为如果 UI 先做复杂了，再回头补 AI 工具真相层，会导致又一轮重构。

---

## 每阶段验收标准

### 阶段 1 验收

- 预览、时间轴、选中态不再各自维护重复状态

### 阶段 2 验收

- 时间轴支持正式的 header/ruler/playhead/scrollbar 结构

### 阶段 3 验收

- 素材点击追加、拖拽插入、切片插入全部可用

### 阶段 4 验收

- Remotion 场景里至少能改标题、字幕、overlay 位置和动画

### 阶段 5 验收

- AI 能独立完成：
  - 读取工程
  - 插入素材
  - 调整片段
  - 切割
  - 更新场景
  - 发起导出

### 阶段 6 验收

- 切换页面不影响 AI 剪辑 / 导出继续运行

### 阶段 7 验收

- 导出进度、完成、失败全部可见且不中断 UI

---

## 结论

这次改造的核心不是“把视频页面做得更像另一个项目”，而是把 RedBox 视频稿件页升级为：

- 一个正式的视频编辑器状态系统
- 一个可供用户与 AI 共用的工程操作层
- 一个前后端解耦的编辑器事件系统

最重要的落点只有一句话：

**用户在 UI 上做的每一个编辑动作，都必须存在等价的 `redbox_editor` 工具调用；AI 通过工具调用完成的每一个编辑动作，也都必须能被前端编辑器立即消费和展示。**
