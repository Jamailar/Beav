---
title: RedConvert 自动剪辑 V2 重做实施方案
doc_type: plan
execution_status: in_progress
execution_stage: phase_18_asset_baseline_timeline_implemented
last_updated: 2026-05-01
owner: codex
protected_modules:
  - desktop/src/components/manuscripts/remotion/
  - desktop/src/remotion/
target_files:
  - desktop/shared/videoAutoEdit.ts
  - desktop/electron/core/video-auto-edit/
  - desktop/electron/core/video-editor-v2/
  - desktop/electron/preload.ts
  - desktop/electron/main.ts
  - desktop/electron/core/tools/appCliTool.ts
  - desktop/src/components/video-editor-v2/
  - desktop/src/features/video-editor-v2/
  - desktop/src/pages/Manuscripts.tsx
success_metrics:
  - ASR 返回 SRT 后可生成字幕轨并作为自动剪辑主轴
  - 可从素材一键生成可编辑粗剪时间线
  - 可把 V2 时间线转换为现有 RemotionCompositionConfig
  - 可保存 Remotion composition 快照、导出时间线 SRT，并从 V2 项目触发 MP4 渲染
  - App AI 可通过 `app_cli video-edit ...` 调用 V2 自动剪辑链路
  - 字幕段可点击定位到 Remotion preview 对应时间
  - 自动剪辑可生成 title card，并通过 adapter 映射到 Remotion 场景
  - 自动剪辑计划先保存为 `planned`，用户或 AI 显式 `apply-auto-edit` 后才改写 timeline
  - 修改字幕文本会同步已应用 timeline 的 subtitle clip，确保 preview 使用最新字幕
  - Transcript Panel 支持相邻字幕合并和单条字幕拆分，并同步 edited SRT 与已应用 timeline
  - Timeline clip 支持选择、定位预览、非破坏性删除/恢复；被删除 clip 不进入 Remotion adapter
  - Timeline primary clip 支持 0.5s 步进裁剪，关联字幕自动收缩，后续 clip 自动前移
  - Timeline primary clip 支持中点拆分，并按字幕位置分配拆分后两个 clip 的 segment 关联
  - Timeline 支持 Fit/2x/4x/8x 缩放视窗，长时间线按 viewport 裁剪渲染
  - Timeline 支持点击轨道定位播放头并同步 Remotion preview seek
  - Timeline primary clip 支持拖拽排序和前移/后移，排序后关联字幕自动平移
  - Timeline 改动和 apply auto-edit 支持项目内 undo stack，可从 UI、IPC、app_cli 恢复上一版时间线
  - 导入素材时自动 probe 媒体 metadata，生成缩略图，并按阈值为长视频/大分辨率视频生成低清 proxy
  - 导入视频/音频素材后自动生成 asset-backed baseline timeline，未运行自动剪辑前也可预览和手动剪辑
  - 长 SRT 字幕列表使用分批渲染，避免一次性渲染 5000 条字幕
  - Remotion 模块零改动，仅由新 adapter 消费
  - 旧剪辑工作台可被新入口替换，不再作为实现约束
---

# RedConvert 自动剪辑 V2 重做实施方案

## 1. 方案结论

当前剪辑功能不再作为兼容边界。V2 直接重做剪辑层，把“字幕驱动的自动粗剪”作为核心能力，把 Remotion 作为不可改动的预览和渲染表现层。

推荐路线：

`素材导入 -> ASR 生成 SRT -> SRT 结构化 -> AI 生成剪辑决策 -> 确定性时间线引擎 -> Remotion adapter -> 预览/渲染/导出`

关键约束：

- `desktop/src/components/manuscripts/remotion/` 不改。
- `desktop/src/remotion/` 不改。
- 旧的 `ExperimentalVideoWorkbench`、`VideoDraftWorkbench`、`EditableTrackTimeline`、`EditorProjectFile` 不再决定 V2 架构。
- V2 可以保留旧入口作 fallback，但新剪辑能力应有独立数据模型、独立 store、独立 UI。
- ASR 不需要复杂设计。模型返回 SRT，V2 负责保存、解析、校验、编辑和回写。

## 2. 产品目标

V2 的目标不是“视频生成器”，而是“字幕驱动的自动剪辑工作台”：

1. 用户导入一个或多个视频素材。
2. 系统调用 ASR，得到标准 SRT。
3. SRT 被解析成可编辑字幕片段，每个字幕片段天然对应时间范围。
4. 用户可以直接按字幕选择、删除、保留、合并、拆分内容。
5. AI 基于 SRT、用户目标、素材信息生成粗剪计划。
6. 确定性剪辑引擎把粗剪计划变成时间线，避免让 AI 直接拼接底层时间线。
7. 新时间线通过 adapter 转成 `RemotionCompositionConfig`。
8. Remotion 只负责现有预览和渲染表达，不承载自动剪辑业务逻辑。

第一版必须做通：

- 单视频口播素材的字幕识别。
- 基于字幕的自动删减和重排。
- 可编辑字幕轨。
- 可编辑粗剪时间线。
- Remotion preview。
- 导出一个可用视频。

多机位、复杂 B-roll、智能视觉理解可以后置，但架构必须提前留出轨道和候选片段模型。

## 3. 总体架构

### 3.1 新增主目录

主进程：

- `desktop/electron/core/video-auto-edit/`
- `desktop/electron/core/video-editor-v2/`

Renderer：

- `desktop/src/components/video-editor-v2/`
- `desktop/src/features/video-editor-v2/`

共享协议：

- `desktop/shared/videoAutoEdit.ts`

Remotion adapter：

- `desktop/src/features/video-editor-v2/remotionAdapter.ts`

注意：adapter 可以 import 现有 Remotion 类型，但不能修改 Remotion 模块。

### 3.2 分层职责

| 层 | 职责 | 是否自研 | 说明 |
| --- | --- | --- | --- |
| ASR/SRT 接入 | 调用 ASR、保存 SRT、解析字幕段 | 半自研 | ASR 用外部模型，SRT parser 自研轻量实现 |
| 媒体分析 | ffprobe 元数据、缩略图、proxy、静音段 | 调现成库 | 必须用 FFmpeg/ffprobe |
| AI 剪辑计划 | 根据字幕和目标生成结构化剪辑意图 | 自研编排 | LLM 只输出 JSON plan，不直接写时间线 |
| 剪辑决策引擎 | 把 plan + SRT 变成确定性 timeline | 自研 | 核心差异化能力 |
| V2 时间线模型 | clip/subtitle/music/effect tracks | 自研 | 不复用旧 `EditorProjectFile` 作为主模型 |
| UI 工作台 | 字幕驱动编辑、时间线、Inspector | 自研 | 可复用现有视觉组件，但不继承旧交互结构 |
| Remotion 表现层 | preview/render composition | 现有模块 | 只能消费，不能改 |
| 导出 | 根据 composition 或 ffmpeg recipe 生成产物 | 组合实现 | Remotion 渲染优先，FFmpeg 做辅助 |

### 3.3 数据流

```text
MediaAsset
  -> MediaProbeRecord
  -> ASR SRT
  -> SrtSegment[]
  -> TranscriptTrack
  -> AutoEditPlan
  -> EditDecision[]
  -> VideoEditorV2Project
  -> RemotionCompositionConfig
  -> Preview / Render / Export
```

### 3.4 运行边界

Renderer 只负责交互和预览，不直接跑 FFmpeg、ASR、文件写入。

主进程负责：

- 素材入库。
- 文件 I/O。
- ASR 调用。
- FFmpeg/ffprobe。
- 自动剪辑任务编排。
- 项目保存。

Preload 暴露命名 API：

- `videoEditorV2:createProject`
- `videoEditorV2:importAssets`
- `videoEditorV2:runAsr`
- `videoEditorV2:importSrt`
- `videoEditorV2:updateSrtSegment`
- `videoEditorV2:generateAutoEdit`
- `videoEditorV2:updateTimeline`
- `videoEditorV2:saveProject`
- `videoEditorV2:render`
- `videoEditorV2:export`

不要在页面里散落裸 `invoke` 字符串。

## 4. 核心数据模型

V2 不以旧 `EditorProjectFile` 为主模型。推荐新增 `desktop/shared/videoAutoEdit.ts`：

```ts
export type VideoEditorV2ProjectStatus =
    | 'draft'
    | 'analyzing'
    | 'transcribing'
    | 'ready'
    | 'auto_editing'
    | 'rendering'
    | 'exported'
    | 'failed';

export interface VideoEditorV2Project {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    status: VideoEditorV2ProjectStatus;
    canvas: VideoCanvasSpec;
    assets: MediaAssetRecord[];
    transcriptTracks: TranscriptTrack[];
    timeline: VideoTimelineV2;
    autoEditRuns: AutoEditRunRecord[];
    remotionSnapshot?: RemotionSnapshotRecord | null;
    renderOutputs: RenderOutputRecord[];
}

export interface VideoCanvasSpec {
    width: number;
    height: number;
    fps: number;
    aspectRatio: '16:9' | '9:16' | '1:1' | '4:5' | 'custom';
}

export interface MediaAssetRecord {
    id: string;
    kind: 'video' | 'audio' | 'image';
    sourcePath: string;
    projectPath: string;
    proxyPath?: string | null;
    thumbnailPath?: string | null;
    durationMs?: number;
    width?: number;
    height?: number;
    fps?: number;
    hash: string;
    probe?: MediaProbeRecord;
}

export interface TranscriptTrack {
    id: string;
    assetId: string;
    language?: string;
    sourceSrtPath: string;
    normalizedJsonPath: string;
    segments: SrtSegment[];
}

export interface SrtSegment {
    id: string;
    index: number;
    assetId: string;
    startMs: number;
    endMs: number;
    text: string;
    confidence?: number | null;
    speaker?: string | null;
    tags: Array<'keep' | 'remove' | 'highlight' | 'hook' | 'filler' | 'unclear'>;
}

export interface VideoTimelineV2 {
    id: string;
    durationMs: number;
    tracks: VideoTimelineTrack[];
}

export interface VideoTimelineTrack {
    id: string;
    kind: 'primary-video' | 'b-roll' | 'subtitle' | 'music' | 'voiceover' | 'effect';
    name: string;
    locked?: boolean;
    muted?: boolean;
    clips: VideoTimelineClip[];
}

export interface VideoTimelineClip {
    id: string;
    assetId?: string;
    transcriptSegmentIds?: string[];
    sourceStartMs: number;
    sourceEndMs: number;
    timelineStartMs: number;
    timelineEndMs: number;
    playbackRate?: number;
    crop?: VideoCropSpec;
    transform?: VideoTransformSpec;
    style?: VideoClipStyle;
    text?: string;
}

export interface AutoEditRunRecord {
    id: string;
    createdAt: string;
    userGoal: string;
    targetDurationMs?: number | null;
    plan: AutoEditPlan;
    decisions: EditDecision[];
    status: 'completed' | 'failed';
    error?: string;
}
```

关键设计点：

- SRT segment 是一等公民，不只是字幕导出文件。
- 时间线 clip 可以引用 `transcriptSegmentIds`，保证字幕编辑和剪辑片段能互相定位。
- AI plan 和 deterministic decisions 分开保存，方便复盘和局部重剪。
- `RemotionSnapshotRecord` 只保存由 adapter 生成的 composition 快照，不反向污染 V2 timeline。

## 5. 模块拆分

### 5.1 `videoEditorV2ProjectStore`

路径：

- `desktop/electron/core/video-editor-v2/videoEditorV2ProjectStore.ts`

职责：

- 创建 V2 项目。
- 维护项目目录。
- 保存 `project.json`。
- 保存 SRT、analysis、thumbs、proxy、render outputs。
- 提供 narrow lock，不在持锁期间做慢 I/O。

建议目录结构：

```text
video-editor-v2/
  <project-id>/
    project.json
    assets/
    proxy/
    thumbs/
    subtitles/
      source.srt
      normalized.json
    analysis/
      media-probe.json
      silence.json
      scene-candidates.json
    remotion/
      composition.latest.json
    renders/
```

实现规则：

- `project.json` 保存相对路径，避免项目迁移后绝对路径失效。
- 素材 hash 使用 size + mtime + 快速采样 hash，避免大文件全量 hash 阻塞。
- 每次保存写临时文件再 rename，避免项目损坏。

### 5.2 `asrSrtService`

路径：

- `desktop/electron/core/video-auto-edit/asrSrtService.ts`

职责：

- 从视频抽音频。
- 调用已配置 ASR 模型。
- 接收 SRT 文本。
- 保存原始 SRT。
- 调用 parser 生成 `SrtSegment[]`。

现成库：

- 音频抽取必须用 FFmpeg。
- ASR 使用现有模型配置和网络调用能力，不在本地内置 Whisper。

自研部分：

- SRT parse。
- SRT normalize。
- SRT segment ID 生成。
- 时间戳校验和修复。

第一版接口：

```ts
export interface RunAsrToSrtInput {
    projectId: string;
    assetId: string;
    language?: string;
    force?: boolean;
}

export interface RunAsrToSrtResult {
    transcriptTrack: TranscriptTrack;
    sourceSrtPath: string;
    segmentCount: number;
    durationMs: number;
}
```

处理策略：

- 如果 ASR 返回空 SRT，任务失败并保留错误。
- 如果 SRT 时间重叠，normalize 阶段只做最小修正，不擅自重写文本。
- 如果用户导入外部 SRT，走同一个 parser 和 normalize 流程。
- SRT 修改后立即更新 `normalized.json`，但不覆盖原始 `source.srt`，导出时另存 `edited.srt`。

### 5.3 `srtParser`

路径：

- `desktop/electron/core/video-auto-edit/srtParser.ts`

职责：

- 解析标准 SRT。
- 输出稳定 `SrtSegment[]`。
- 支持 CRLF/LF。
- 支持多行字幕合并。
- 支持毫秒级时间转换。

不建议引入大型字幕库。SRT 格式足够简单，轻量 parser 更可控。

必要测试用例：

- 标准 SRT。
- 多行字幕。
- 空行异常。
- 时间重叠。
- 缺失 index。
- 逗号和点号毫秒分隔。

### 5.4 `mediaProbeService`

路径：

- `desktop/electron/core/video-auto-edit/mediaProbeService.ts`

职责：

- 调用 ffprobe 读取素材元数据。
- 生成缩略图。
- 生成 proxy。
- 可选生成静音段。

必须使用：

- `ffprobe`
- `ffmpeg`

第一版不做重视觉理解，只做自动剪辑必需信息：

- duration。
- width/height。
- fps。
- audio stream 是否存在。
- rotation。
- thumbnail。
- proxy path。

性能规则：

- 长视频必须优先生成低清 proxy 供 UI 预览。
- probe 结果按 asset hash 缓存。
- 缩略图按需生成，不一次性抽完整 storyboard。

当前实现状态：

- 已新增 `desktop/electron/core/video-auto-edit/mediaProbeService.ts`。
- 复用已打包的 `ffmpeg-static`，不新增 `ffprobe-static` 打包依赖；metadata 通过 `ffmpeg -i` 输出解析，缩略图和 proxy 由 ffmpeg 生成。
- 导入素材时按 asset hash 写入 `analysis/probe-cache.json`，重复导入同 hash 素材时复用 probe/thumbnail/proxy 结果。
- 第一版 proxy 阈值为 `REDBOX_VIDEO_PROXY_THRESHOLD_MS` 或默认 120 秒；视频超过阈值或分辨率高于 1280x720 时生成 720p 级低清 MP4 proxy。
- UI 资产卡片展示 duration、尺寸、fps 和 proxy 标记，方便判断后续剪辑是否使用了探测结果。

### 5.4.1 Asset-backed baseline timeline

当前实现状态：

- 导入素材完成后，`importAssetsToVideoEditorV2Project` 会把新导入的视频/音频追加成 primary track clip。
- 生成策略是保守追加：如果 timeline 已有用户剪辑或 auto-edit 结果，不覆盖旧 clip，只把新素材放到当前 timeline 末尾。
- baseline clip 使用素材真实 `durationMs` 作为 source/timeline duration；probe 失败时使用 3 秒 fallback，保证 UI 仍有可编辑对象。
- 图片素材暂不进入 primary track，避免在没有明确时长和展示策略时污染视频主轨。
- baseline clip 的 `text` 仅用于 Timeline UI 显示素材名；Remotion adapter 对有 asset 的 clip 不会把它渲染为标题卡。

### 5.5 `autoEditPlanner`

路径：

- `desktop/electron/core/video-auto-edit/autoEditPlanner.ts`

职责：

- 组织 LLM 输入。
- 根据 SRT、用户目标、目标时长、风格参数生成 `AutoEditPlan`。
- 不直接输出 Remotion 配置。
- 不直接输出最终时间线。

输入摘要：

```ts
export interface AutoEditPlannerInput {
    project: VideoEditorV2Project;
    transcript: TranscriptTrack;
    userGoal: string;
    targetDurationMs?: number;
    pacing: 'tight' | 'balanced' | 'slow';
    contentMode: 'shorts' | 'tutorial' | 'review' | 'vlog' | 'custom';
}
```

输出：

```ts
export interface AutoEditPlan {
    summary: string;
    selectedSegments: Array<{
        segmentId: string;
        reason: string;
        role: 'hook' | 'context' | 'proof' | 'detail' | 'cta' | 'filler-removal';
        priority: number;
    }>;
    removedSegments: Array<{
        segmentId: string;
        reason: string;
    }>;
    titleCards: Array<{
        afterSegmentId?: string;
        text: string;
        durationMs: number;
    }>;
    subtitleStyle: SubtitleStylePreset;
    warnings: string[];
}
```

AI 约束：

- 只允许引用已有 `segmentId`。
- 不允许编造时间码。
- 不允许编造素材路径。
- 不允许生成 Remotion JSX。
- JSON schema 校验失败必须重试一次。

### 5.6 `editDecisionEngine`

路径：

- `desktop/electron/core/video-auto-edit/editDecisionEngine.ts`

职责：

- 把 `AutoEditPlan` 转成确定性 `EditDecision[]`。
- 解决片段排序、转场、字幕对齐、总时长约束。
- 生成 `VideoTimelineV2`。

规则：

- 默认按 SRT 原始顺序排列，除非用户明确选择“重排叙事”。
- `keep` 标签片段必须保留。
- `remove` 标签片段默认排除。
- clip 边界以 SRT segment start/end 为主，可向两侧扩 80-160ms 保留自然语气。
- 小于 300ms 的孤立片段不单独成 clip。
- 相邻片段间隔小于 500ms 时合并为同一 clip。
- 转场默认只在非连续素材之间添加。

这是 V2 的核心自研模块。AI 负责“选什么、为什么”，engine 负责“如何剪、如何落地”。

### 5.7 `remotionCompositionAdapter`

路径：

- `desktop/src/features/video-editor-v2/remotionAdapter.ts`

职责：

- 把 `VideoTimelineV2` 转成现有 `RemotionCompositionConfig`。
- 消费现有类型：
  - `RemotionCompositionConfig`
  - `RemotionScene`
  - `RemotionOverlay`
  - `RemotionTransition`
- 不修改 `desktop/src/components/manuscripts/remotion/`。

转换策略：

- primary video clip -> `RemotionScene`。
- subtitle clip -> scene `overlay` 或 text entity。
- title card -> standalone scene/entity。
- transition -> existing `RemotionTransition`。
- crop/transform -> `sceneItemTransforms`。

第一版只做最小映射：

```ts
export function buildRemotionCompositionFromV2Project(
    project: VideoEditorV2Project,
): RemotionCompositionConfig {
    // V2 timeline -> Remotion scenes
}
```

边界规则：

- V2 timeline 是 source of truth。
- Remotion composition 是 derived snapshot。
- UI 保存时先保存 V2 project，再重新生成 composition。
- 如果 Remotion 类型表达不了某个 V2 能力，adapter 降级，不反向修改 Remotion。

### 5.8 `renderExportService`

路径：

- `desktop/electron/core/video-editor-v2/renderExportService.ts`

职责：

- 接收 projectId 和 render preset。
- 读取 latest Remotion composition snapshot。
- 调用现有 Remotion render 能力或现有 Remotion bundle 入口。
- 产物写入 `renders/`。

策略：

- 优先走 Remotion 输出完整视频，因为字幕、标题、动画都在 composition 中。
- FFmpeg 只做辅助：抽音频、proxy、简单拼接验证、封装转换。
- 不在 V2 第一版实现复杂多路 render queue，先做到单任务可取消、可重试。

## 6. UI 实现方案

### 6.1 新工作台结构

新增组件目录：

```text
desktop/src/components/video-editor-v2/
  VideoEditorV2Workbench.tsx
  VideoEditorToolbar.tsx
  AssetBinPanel.tsx
  TranscriptPanel.tsx
  AutoEditPanel.tsx
  RemotionPreviewPanel.tsx
  TimelineV2.tsx
  TimelineTrack.tsx
  TimelineClip.tsx
  SubtitleSegmentList.tsx
  InspectorPanel.tsx
  RenderExportPanel.tsx
```

页面布局：

```text
┌──────────────────────────────────────────────────────────────┐
│ Toolbar: Import | ASR | Auto Edit | Preview | Render | Export │
├───────────────┬──────────────────────────────┬───────────────┤
│ Asset / SRT   │ Remotion Preview             │ Inspector     │
│ Transcript    │                              │ Auto-edit plan│
├───────────────┴──────────────────────────────┴───────────────┤
│ Timeline: video track / subtitle track / music / effects      │
└──────────────────────────────────────────────────────────────┘
```

交互原则：

- 字幕列表和时间线联动。
- 点击字幕段，高亮对应 timeline clip 和 preview time。
- 删除字幕段不一定删除原文，默认只是把 segment 标记为 `remove`。
- 用户可以把字幕段标记为 `keep`、`hook`、`highlight`。
- 自动剪辑后，用户看到的是可编辑时间线，而不是一次性黑盒结果。

### 6.2 Toolbar

按钮：

- `导入素材`
- `识别字幕`
- `导入 SRT`
- `自动剪辑`
- `重新生成`
- `预览`
- `渲染`
- `导出`

状态展示：

- ASR running。
- Auto edit running。
- Render progress。
- Unsaved changes。

实现要求：

- 不要全页 loading 覆盖已有内容。
- 任务运行时只锁定相关按钮。
- 保留上一次成功时间线，失败时以内联错误展示。

### 6.3 Transcript Panel

这是 V2 的主编辑面板，不是辅助字幕面板。

功能：

- 展示 SRT segment 列表。
- 支持搜索。
- 支持按标签过滤。
- 支持编辑字幕文本。
- 支持合并相邻字幕。
- 支持拆分字幕。
- 支持标记 keep/remove/highlight/hook。
- 支持从字幕段生成 clip。
- 合并/拆分后写回 `normalized.json` 和 edited SRT；如果 timeline 已应用，会同步受影响 subtitle clip，避免 preview 指向失效 segment。

每行内容：

- index。
- start/end。
- text。
- tags。
- include/exclude toggle。
- quick seek。

性能：

- 长 SRT 必须虚拟列表。
- 编辑单个 segment 只更新局部状态。
- 5000 条字幕以内操作保持流畅。

### 6.4 Auto Edit Panel

功能：

- 输入剪辑目标，例如“剪成 60 秒口播短视频”。
- 设置目标时长。
- 设置节奏。
- 设置用途。
- 设置字幕风格。
- 生成剪辑计划。
- 展示 AI 选择和删除的 segment。
- 允许用户应用或撤销本次 plan。
- 第一版撤销只覆盖时间线级操作：apply auto-edit、clip 删除/恢复、裁剪、拆分、排序；撤销会恢复上一版 `timeline` 和 `autoEditRuns`，不把字幕文本编辑伪装成可撤销。

用户可见 plan：

- 保留哪些片段。
- 删除哪些片段。
- 每个片段的原因。
- 是否有潜在断句问题。
- 预计成片时长。

交互要求：

- AI plan 先预览，用户点击 `应用到时间线` 后才改 timeline。
- 应用后仍可 undo。
- 已实现项目内 `undoStack`，每次时间线级写入前保存快照，UI 的 Timeline header、IPC `videoEditorV2:undo-timeline` 和 `app_cli video-edit undo` 都可恢复上一版。
- plan 失败不影响已有 timeline。

### 6.5 Remotion Preview Panel

职责：

- 使用 adapter 生成的 `RemotionCompositionConfig`。
- 渲染现有 Remotion preview。
- 支持 seek。
- 支持播放/暂停。
- 支持按 timeline selection 定位。

约束：

- 不改 `RemotionVideoPreview.tsx`。
- 不改 `VideoMotionComposition.tsx`。
- 如果现有 preview 组件缺少能力，V2 在外层包一层控制器，不改内部模块。

### 6.6 Timeline V2

轨道：

- Primary video。
- Subtitle。
- B-roll。
- Music。
- Effect/title。

第一版重点：

- Primary video clip 拖拽排序。
- 第一版排序支持拖拽 primary clip 到目标 clip 前/后，也支持 Inspector 中前移/后移；排序会重新铺排 primary track 的连续时间，并按 `transcriptSegmentIds` 平移关联 subtitle clip。
- Timeline header 提供撤销按钮，显示当前可撤销数量；撤销恢复上一版时间线和自动剪辑 run 状态，避免 apply 后无法回退。
- Clip trim。
- 第一版 clip trim 支持选中 primary video 后按 0.5s 裁剪开头/结尾；裁掉开头时关联字幕按裁剪量前移并裁掉越界区间，裁掉结尾时关联字幕被夹紧或隐藏。
- 裁剪会对目标片段后方所有轨道 clip 做 ripple 前移，避免 timeline 留空；源 SRT 不删除，变更只落在 timeline clip。
- Subtitle clip 同步展示。
- 删除/恢复。
- 第一版删除/恢复使用 `disabled` 状态，不直接从 project 删除 clip；恢复时不需要重新生成自动剪辑。
- 删除 primary video clip 时同步隐藏关联 subtitle clip，避免导出残留字幕。
- 简单 split。
- 第一版 split 支持选中 primary video 素材片段后一键中点拆分；总 timeline 时长不变，字幕 track 不重建，拆分后的两个 primary clip 按字幕位置分配 `transcriptSegmentIds`，保证后续删除/恢复仍能联动对应字幕。
- 播放头 seek。
- 第一版播放头支持点击任意 timeline rail 定位；字幕点击、clip selection、rail 点击都会同步播放头和 Remotion preview。
- 缩放 timeline。
- 第一版 timeline zoom 支持 Fit/2x/4x/8x 可视窗口和滑条定位；字幕 seek、clip selection 会自动把 timeline viewport 聚焦到对应时间点。

暂不做：

- 复杂关键帧曲线。
- 多层混合模式。
- 专业调色。
- 多机位自动同步。

Timeline 状态必须存到 V2 project，不存到 Remotion composition。

### 6.7 Inspector Panel

根据选择对象变化：

- 选中字幕段：编辑文本、标签、起止时间。
- 选中 video clip：trim、速度、裁剪、音量。
- 选中 title card：文本、时长、样式。
- 选中 timeline：canvas、fps、比例、默认字幕样式。

## 7. 方案对比

| 方案 | 描述 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A. 修补旧剪辑功能 | 在 `ExperimentalVideoWorkbench` / `VideoDraftWorkbench` 上继续加自动剪辑 | 改动少 | 旧模型和交互会继续拖累字幕驱动流程，自动剪辑难以做成主轴 | 不推荐 |
| B. V2 重做剪辑层，保护 Remotion | 新建 V2 project/timeline/UI，adapter 输出 Remotion composition | 架构清晰，能围绕 SRT 自动剪辑重建体验，风险集中在新模块 | 需要替换入口，初期工作量较大 | 推荐 |
| C. 独立 Pixelle 式流水线 | 做一个独立自动生成器，产出视频文件 | 最快看到自动成片 | 不可编辑，难接 RedConvert 创作链路，Remotion 价值被削弱 | 不推荐 |
| D. 只做 SRT 字幕工具 | 仅 ASR 和字幕编辑，不做自动剪辑 | 风险低 | 没有解决核心目标 | 不推荐 |

推荐 B。原因是用户真正需要的是“自动剪辑 + 可继续编辑 + Remotion 表现层”，不是一次性视频生成。

## 8. 现成库与自研边界

必须使用现成库：

- FFmpeg：抽音频、proxy、缩略图、基础媒体处理。
- ffprobe：媒体元数据。
- 现有 ASR 模型服务：返回 SRT。
- 现有 Remotion 模块：preview/render 表达。

应该自研：

- SRT parser 和 normalizer。
- 字幕驱动 timeline 模型。
- AI plan schema。
- edit decision engine。
- V2 project store。
- V2 workbench UI。
- Remotion adapter。

暂不引入：

- OpenCV。
- PySceneDetect。
- 本地 Whisper。
- 专业 NLE 级复杂 timeline engine。
- 新的 canvas 渲染引擎。

## 9. AI 实现方式

AI 不直接剪视频。AI 只做结构化判断：

- 哪些字幕段应保留。
- 哪些字幕段应删除。
- 哪些片段是 hook、铺垫、证明、CTA。
- 是否需要 title card。
- 字幕风格建议。
- 可能的断句风险。

系统 prompt 约束：

- 只能引用输入中的 `segmentId`。
- 输出必须符合 JSON schema。
- 不要输出代码。
- 不要输出 Remotion 配置。
- 不要生成不存在的素材。
- 不要生成不存在的时间码。

工具接入：

- 在 `appCliTool.ts` 增加高频 action：
  - `video_editor_v2.create_project`
  - `video_editor_v2.run_asr`
  - `video_editor_v2.generate_auto_edit`
  - `video_editor_v2.apply_auto_edit`
  - `video_editor_v2.render`

这样后续 RedClaw / chat runtime 可以直接驱动自动剪辑，而不是靠自然语言猜页面状态。

## 10. 性能优化策略

### 10.1 媒体处理

- 所有 FFmpeg 任务在主进程异步执行，不阻塞 renderer。
- 大视频先生成 proxy。
- 缩略图按视口附近按需生成。
- ffprobe 结果按 asset hash 缓存。
- ASR 音频抽取文件按 asset hash 缓存。

### 10.2 SRT 和 timeline

- SRT segment 使用 normalized JSON 缓存。
- Transcript list 使用虚拟滚动。
- Timeline clip 渲染按 viewport 裁剪。
- Adapter 增量重建：字幕文本变更只更新相关 scene/overlay。
- Preview composition 生成 debounce，避免每次键入都重建。

### 10.3 AI 调用

- LLM 输入只传 SRT 结构摘要，不传完整项目大对象。
- 长 SRT 分块摘要，再做最终 plan。
- 低风险操作用确定性规则，不交给 AI。
- plan 结果保存，可复用、可 diff、可回滚。

### 10.4 存储

- 项目保存使用原子写。
- 大文件不写入 JSON，只保存路径和 metadata。
- render outputs 分目录保存，避免项目根目录变乱。

## 11. 入口替换策略

旧功能不用继续维护为主路径。

建议：

1. 在 Manuscripts 视频稿件区域新增 `打开 V2 剪辑工作台`。
2. 新建项目默认进入 V2。
3. 旧 workbench 只保留隐藏 fallback 或临时入口。
4. 等 V2 达到导出闭环后，移除默认旧入口。

入口改造点：

- `desktop/src/pages/Manuscripts.tsx`
- 当前 lazy import 的 `ExperimentalVideoWorkbench`
- 与视频稿件 packageState 绑定的 video project 保存逻辑

原则：

- 不把 V2 强行塞进旧 props。
- 如果 Manuscripts 需要保存引用，只保存 `videoEditorV2ProjectId` 和 latest render path。
- V2 项目自身由 V2 store 管。

## 12. 实施步骤

### Step 1：共享协议和项目存储

目标：

- 新增 `desktop/shared/videoAutoEdit.ts`。
- 新增 `videoEditorV2ProjectStore`。
- 完成 create/load/save 项目。

验收：

- 能创建 V2 项目目录。
- `project.json` 可保存和重新加载。
- front-end 能拿到空 timeline。

### Step 2：ASR/SRT 主链路

目标：

- 新增 `asrSrtService`。
- 新增 `srtParser`。
- 支持 ASR 返回 SRT。
- 支持导入外部 SRT。

验收：

- 视频素材可以生成 `source.srt`。
- SRT 可以解析为 `SrtSegment[]`。
- UI 能展示字幕段。
- 编辑字幕后能保存 `normalized.json`。

### Step 3：V2 UI 骨架

目标：

- 新增 `VideoEditorV2Workbench`。
- 完成 toolbar、asset panel、transcript panel、preview panel、timeline shell、inspector。
- 从 Manuscripts 打开 V2。

验收：

- 不依赖旧 `VideoDraftWorkbench`。
- 字幕点击能 seek。
- 修改字幕能更新项目状态。
- 修改字幕文本后，已应用 timeline 中对应 subtitle clip 会同步更新，preview 不读取旧字幕。

### Step 4：自动剪辑计划和决策引擎

目标：

- 新增 `autoEditPlanner`。
- 新增 `editDecisionEngine`。
- 生成 `AutoEditPlan` 和 `VideoTimelineV2`。

验收：

- 输入 SRT 和目标时长后可生成粗剪。
- 用户能查看保留/删除原因。
- 点击应用后 timeline 更新。
- 失败不清空已有 timeline。
- 生成计划不直接覆盖已有 timeline，只有应用计划才写入 V2 timeline。

### Step 5：Remotion adapter 和 preview

目标：

- 新增 `remotionAdapter.ts`。
- 把 V2 timeline 转成 `RemotionCompositionConfig`。
- 用现有 Remotion preview 展示。

验收：

- 不修改 Remotion 目录。
- timeline clip 能在 preview 播放。
- 字幕作为 overlay 展示。
- title card 能展示。

### Step 6：渲染和导出

目标：

- 新增 `renderExportService`。
- 接入 render IPC。
- 输出 mp4 和 edited SRT。

验收：

- 可导出视频文件。
- 可导出编辑后的 SRT。
- render output 回写 V2 project。

### Step 7：AI 工具接入

目标：

- 在 app tool 层暴露 V2 自动剪辑动作。
- 让 RedConvert 内 AI 能创建项目、跑 ASR、生成粗剪、渲染。

验收：

- AI 能通过 tool 调用完整链路。
- 工具输入输出是 typed payload。
- 不通过用户消息关键词硬判断意图。

## 13. 验收标准

完整验收用例：

1. 导入一个口播视频。
2. 点击 `识别字幕`。
3. 得到 SRT，并在 Transcript Panel 看到字幕段。
4. 标记几段为 `keep` 或 `remove`。
5. 输入“剪成 60 秒短视频，节奏紧凑”。
6. 点击 `自动剪辑`。
7. 查看 AI plan，确认保留/删除原因。
8. 应用到 timeline。
9. 在 Remotion preview 播放粗剪。
10. 修改一条字幕文本，preview 更新。
11. 选中主视频 clip，裁剪开头或结尾 0.5 秒，关联字幕和后续 clip 自动对齐。
12. 选中主视频 clip，执行中点拆分，timeline 中出现两个连续主视频片段且字幕预览不丢失。
13. 切换 timeline zoom 到 4x 或 8x，拖动 viewport，clip 按当前视窗裁剪显示。
14. 点击 timeline rail 任意位置，播放头移动，并同步 seek Remotion preview。
15. 拖拽一个 primary clip 到另一个 primary clip 前/后，字幕随对应片段同步移动。
16. 点击 Timeline header 的撤销按钮，上一版时间线恢复；通过 `app_cli video-edit undo --project-id ...` 也能恢复。
17. 导入一个视频素材后，asset 记录包含 duration/width/height/fps/hasAudio；视频生成 thumbnail，超过 proxy 阈值的视频生成 proxy path。
18. 导入视频/音频素材后，不运行自动剪辑也能看到 primary timeline clip；再次导入新素材时，新 clip 追加到已有 timeline 末尾。
16. 删除/恢复一个主视频 clip，被删除 clip 不进入 preview/export。
17. 渲染导出 mp4。
18. 导出 edited SRT。

技术验收：

- Remotion 模块没有 diff。
- 旧剪辑模型不是 V2 source of truth。
- 所有计划和运行状态可保存在 V2 project。
- ASR 失败、AI 失败、render 失败都不会清空已有项目。
- 长 SRT 下 UI 不明显卡顿。
- 纯函数 smoke test 覆盖 SRT parser、heuristic plan、plan/apply 状态、decision engine、title card、Remotion adapter、edited SRT serialization。

## 14. 风险和处理

| 风险 | 处理 |
| --- | --- |
| ASR SRT 时间码质量差 | normalize 阶段只做轻修正，UI 暴露 segment 调整能力 |
| AI 选择片段不稳定 | AI 只产 plan，engine 确定性落地，并保存 plan 供复盘 |
| Remotion 类型无法覆盖所有 V2 表达 | adapter 降级，V2 timeline 保留完整信息 |
| 长视频处理慢 | proxy、缓存、后台任务、局部缩略图 |
| 旧入口和新入口混乱 | 新项目默认 V2，旧入口只做临时 fallback |
| Timeline 复杂度膨胀 | 第一版只支持字幕驱动粗剪需要的编辑能力 |

## 15. 不做事项

第一版明确不做：

- 不做专业 NLE 全功能替代。
- 不做多机位自动同步。
- 不做本地 ASR 模型内置。
- 不做复杂视觉语义理解。
- 不做 Remotion 模块内部改造。
- 不兼容旧剪辑 timeline 作为 V2 主模型。

## 16. 推荐实现顺序

最优顺序是：

1. V2 project store。
2. ASR/SRT pipeline。
3. Transcript-first UI。
4. Auto edit planner。
5. Edit decision engine。
6. Remotion adapter。
7. Render/export。
8. AI tool integration。

原因：

- ASR/SRT 是最小可用主轴。
- UI 先围绕字幕跑通，自动剪辑才有可靠编辑对象。
- Remotion adapter 后置，避免一开始被表现层绑架数据模型。
- Render/export 最后接入，确保导出的就是用户可编辑时间线的结果。
