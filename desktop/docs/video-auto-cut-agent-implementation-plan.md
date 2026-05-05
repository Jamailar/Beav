---
doc_type: plan
execution_status: not_started
last_updated: 2026-05-05
---

# AI 自动剪视频实施计划

Status: Current

## Scope

本计划定义 RedBox 的 AI 自动剪视频能力。目标不是新增一套一次性脚手架，也不是把 Pixelle-Video 式独立生成流水线照搬进来，而是把自动剪辑做成：

```text
一个专用 skill
  -> 调用一个通用 editor workflow
    -> host 内部执行 ASR、EDL、timeline、字幕、预览、导出
```

第一目标场景：

- 用户上传自己的口播视频。
- AI 自动转字幕。
- AI 删除语气词、明显口误、重复句、长停顿。
- AI 自动加字幕。
- 结果必须落成可继续编辑的 video project / canonical timeline。

第二目标场景：

- 用户上传其他类型视频。
- AI 根据用户目标做自动粗剪，例如高光、缩短、去废话、保留重点。
- 仍然输出可编辑 timeline，不输出不可审计的黑盒 MP4。

## Product Position

本能力属于视频编辑器，不属于媒体生成 runtime。

- `media_generation` 只负责 provider 视频生成、轮询、下载、绑定素材。
- `video_editor.auto_cut` 负责已有视频的分析、剪辑、字幕和 timeline mutation。
- RedClaw / Chat / Workboard 都可以通过同一个 workflow 调用它。
- UI 只展示入口、进度、预览、可撤销结果，不承载剪辑事实源。

## Non Goals

第一版明确不做：

- 不做专业 NLE 全功能替代。
- 不做多机位同步。
- 不做复杂调色。
- 不做 b-roll 自动插入。
- 不做全视频视觉语义理解。
- 不做独立 Pixelle 式 `topic -> storyboard -> TTS -> AI video -> concat` 生成器。
- 不在 renderer 里直接跑 ffmpeg、ASR 或 timeline mutation。
- 不让 agent 直接修改 React state。

## Recommended Architecture

### 1. Skill Layer

新增 skill：

```text
desktop/builtin-skills/redbox-video-autocut/SKILL.md
```

职责：

- 判断用户是否在要求自动剪辑已有视频。
- 将用户目标归一化成 `AutoCutIntent`。
- 对口播、访谈、教程、泛视频做不同策略选择。
- 调用一个 workflow：`video_editor.auto_cut`。
- 执行后解释删除了什么、生成了什么、在哪里预览和继续编辑。

Skill 不能做：

- 不能自己拼 ffmpeg 命令。
- 不能直接写 timeline JSON。
- 不能把用户请求翻译成非结构化长 prompt 后丢给模型。

### 2. Workflow Entry

对 agent 暴露一个稳定入口：

```json
{
  "resource": "video_editor",
  "operation": "run",
  "input": {
    "workflow": "auto_cut",
    "videoPath": "/path/to/input.mp4",
    "goal": "clean_talking_head",
    "targetDurationSec": 60,
    "addSubtitles": true,
    "outputMode": "editable_timeline"
  }
}
```

兼容 CLI 形式：

```text
video auto-cut --input /path/to/input.mp4 --goal clean_talking_head --target-duration 60 --subtitles
```

对模型只暴露一个 workflow，避免顶层工具面膨胀。host 内部仍然拆成小步骤和结构化中间产物，保证可恢复、可测试、可审计。

### 3. Host Service Layer

新增 Rust service 模块：

```text
desktop/src-tauri/src/commands/video_auto_cut.rs
desktop/src-tauri/src/video_auto_cut/
  mod.rs
  types.rs
  probe.rs
  transcribe.rs
  transcript.rs
  planner.rs
  edl.rs
  timeline.rs
  subtitles.rs
  render.rs
  store.rs
```

`commands/video_auto_cut.rs`

- 接收 `video_editor:auto-cut` channel 或 `video_editor.run(auto_cut)` action。
- 做 payload 校验。
- 创建 job。
- 发出 runtime progress events。
- 返回 `AutoCutResult`。

`video_auto_cut/probe.rs`

- 调用 ffprobe。
- 解析 duration、fps、resolution、audio stream、rotation。
- 只写 `MediaProbe`，不做剪辑判断。

`video_auto_cut/transcribe.rs`

- 抽音频。
- 调用现有 transcription endpoint / model slot。
- 生成 word-level 或 segment-level transcript。
- 缺 word timestamp 时降级到 segment timestamp。

`video_auto_cut/transcript.rs`

- 标准化 transcript。
- 合并过短 segment。
- 标记 filler、pause、repeat、unclear、mistake_candidate。
- 生成字幕文本的安全版本。

`video_auto_cut/planner.rs`

- 把 transcript 和用户目标交给 AI planner。
- AI 只产结构化 `EditDecisionList`，不能直接写 timeline。
- planner prompt 必须要求保守删除，所有删除都带 reason。

`video_auto_cut/edl.rs`

- 校验 AI 输出。
- 合并重叠区间。
- 保护最小时长。
- 防止删除整个视频。
- 对口播场景做确定性补充规则：长静音、纯 filler、连续重复。

`video_auto_cut/timeline.rs`

- 把 EDL 编译成 canonical timeline patch。
- 建立 source time 到 output time 的映射。
- 同步字幕轨。
- 写入 video project。

`video_auto_cut/subtitles.rs`

- 根据 output time map 生成 SRT/ASS。
- 同时生成字幕 layer 数据，供 Remotion / FreeCut 预览使用。
- 不强制第一版做花字，只做可读字幕。

`video_auto_cut/render.rs`

- 第一版只生成低成本 preview 或调用现有 render path。
- 导出必须通过现有 Remotion / ffmpeg 边界，不新增自研渲染器。

`video_auto_cut/store.rs`

- 保存 job record、中间产物、最终 timeline。
- 所有自动剪辑 run 可复盘和撤销。

## Data Contracts

### AutoCutInput

```ts
type AutoCutGoal =
  | "clean_talking_head"
  | "remove_fillers"
  | "shorten"
  | "highlights"
  | "generic_rough_cut";

interface AutoCutInput {
  videoPath: string;
  projectPath?: string;
  goal?: AutoCutGoal;
  userInstruction?: string;
  targetDurationSec?: number;
  addSubtitles?: boolean;
  outputMode?: "editable_timeline" | "preview_only";
  language?: string;
}
```

### AutoCutJob

```ts
interface AutoCutJob {
  id: string;
  status: "queued" | "probing" | "transcribing" | "planning" | "applying" | "rendering" | "completed" | "failed";
  input: AutoCutInput;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
```

### TranscriptSegment

```ts
interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  normalizedText: string;
  words?: Array<{
    text: string;
    startMs: number;
    endMs: number;
    confidence?: number;
  }>;
  tags: Array<"filler" | "pause" | "repeat" | "mistake_candidate" | "unclear" | "keep">;
}
```

### EditDecisionList

```ts
interface EditDecisionList {
  version: 1;
  sourceVideoPath: string;
  goal: AutoCutGoal;
  decisions: Array<{
    id: string;
    type: "keep" | "remove" | "trim" | "merge";
    sourceStartMs: number;
    sourceEndMs: number;
    reason: string;
    confidence: number;
    segmentIds: string[];
  }>;
  subtitlePolicy: {
    enabled: boolean;
    maxCharsPerLine: number;
    stylePreset: "default_readable";
  };
  warnings: string[];
}
```

### AutoCutResult

```ts
interface AutoCutResult {
  success: boolean;
  jobId: string;
  projectPath: string;
  timelinePath: string;
  transcriptPath: string;
  edlPath: string;
  subtitlePath?: string;
  previewPath?: string;
  removedDurationMs: number;
  outputDurationMs: number;
  summary: string;
}
```

## Processing Flow

### Talking Head Flow

```text
video_editor.auto_cut
  -> create AutoCutJob
  -> ffprobe input
  -> extract audio
  -> ASR transcript
  -> normalize transcript
  -> detect filler / repeat / pause / mistake candidates
  -> AI planner creates EDL
  -> deterministic EDL validator
  -> compile timeline patch
  -> generate subtitle track
  -> save project + run record
  -> return preview summary
```

口播策略：

- 优先删 filler、重复开头、明显重录句、长静音。
- 对承载情绪和节奏的停顿保持保守。
- 删除前后保留 padding，避免切音头。
- 默认不重排段落，只做清理型剪辑。
- 目标时长存在时，再按段落信息密度评分做压缩。

### Generic Video Flow

```text
video_editor.auto_cut
  -> probe
  -> ASR if audio exists
  -> optional scene detect
  -> segment scoring
  -> AI planner creates EDL
  -> timeline patch
  -> subtitles if requested
```

泛视频策略：

- 有语音时仍以 transcript 为主轴。
- 无语音或弱语音时先降级为 scene-based rough cut。
- 第一版不承诺复杂视觉理解，只做镜头切分和用户目标驱动保留。
- 如果目标需要视觉理解，返回 warning 并要求后续接 `video.analyze` 能力。

## AI Planner Design

Planner 是唯一需要模型判断的步骤。它输入：

- `AutoCutInput`
- `MediaProbe`
- `TranscriptSegment[]`
- 可选 `SceneSegment[]`

它输出：

- `EditDecisionList`

Prompt 约束：

- 只输出 JSON。
- 不允许删除没有 reason 的片段。
- 不允许输出文件路径。
- 不允许假设没有给出的画面内容。
- 所有 `remove` 必须能映射到 transcript segment 或 scene segment。
- 不确定时保留。

失败策略：

- JSON parse 失败：重试一次，附带 schema error。
- 仍失败：回退到 deterministic filler/pause cleanup。
- 删除比例超过阈值：进入 review_required，不自动 apply。

## Tool And Skill Boundary

### One Public Workflow

对 agent 暴露：

```text
video_editor.auto_cut
```

不要把以下内部步骤作为顶层模型工具默认暴露：

- `media.probe`
- `media.transcribe`
- `transcript.normalize`
- `edl.validate`
- `timeline.apply`
- `subtitle.render`

这些可以作为 host 内部 service，也可以作为开发者 CLI debug 子命令，但不进入默认模型工具面。

### Debug Subcommands

为了验证和排障，可以提供：

```text
video auto-cut probe --input input.mp4
video auto-cut transcribe --input input.mp4
video auto-cut plan --project project.redvideo
video auto-cut apply --project project.redvideo --edl edl.json
```

这些命令用于开发和测试，不作为用户主要入口。

## UI Plan

UI 加法必须克制。第一版只加：

### Video Workbench

入口位置：

- 视频稿件编辑器素材区或工具栏。
- 文案：`自动粗剪`。
- 图标：`Scissors`。

点击后打开小型 modal / popover：

- 目标：`清理口播`、`剪成高光`、`缩短到...秒`。
- checkbox：`自动加字幕`。
- 主按钮：`开始`。

运行中：

- 显示进度行，不占用大面积解释文案。
- 进度来自 host job event。

完成后：

- timeline 自动出现结果。
- 右侧或顶部显示一条紧凑 summary：
  - 删除时长。
  - 输出时长。
  - 字幕文件。
  - `撤销`。

### Chat / RedClaw

聊天里用户说“帮我把这个口播视频剪掉废话并加字幕”时：

- skill 激活。
- AI 调用 `video_editor.auto_cut`。
- 返回摘要和项目链接。
- 不要求用户进入复杂向导。

## Required Existing Libraries

必须复用：

- FFmpeg / ffprobe：抽音频、裁切、拼接、preview render。
- 现有 transcription endpoint / model slot：ASR。
- Remotion：字幕 layer / preview / final render 的表达能力。
- vendored FreeCut timeline：可编辑 timeline UI。
- Zustand / existing video editor store：renderer 状态承载。

可以选择性引入：

- PySceneDetect：后续泛视频镜头检测增强。
- Whisper word timestamp provider：如果现有 ASR 无 word-level timestamp。

不要自研：

- 视频解码器。
- 转码器。
- 专业字幕排版引擎。
- 全新 timeline engine。

## Must Self Build

必须自研：

- `AutoCutInput` / `AutoCutResult` schema。
- `EditDecisionList` schema。
- `TranscriptSegment` normalizer。
- filler / repeat / pause detection rules。
- EDL validator。
- source time -> output time mapper。
- timeline patch compiler。
- skill prompt。
- job persistence and run record。
- undo / revert binding。

这些是 RedBox 产品语义，不能交给外部库黑盒处理。

## Performance Strategy

- ffprobe 只跑一次，结果写入 asset metadata。
- ASR 先抽音频，不直接把视频交给模型。
- 长视频按 chunk 转写，但输出统一 transcript。
- planner 输入只传 segment summary，不传全量 word list；word list 留给 validator。
- timeline apply 只写 patch，不全量重建大 project。
- 预览优先低分辨率 proxy。
- 字幕预览走 layer，不默认烧录。
- 导出走后台 job，UI stale-while-revalidate，不清空当前工程。
- 对同一 input hash + options 的 transcript / EDL 做缓存。

## Safety And Review Rules

自动剪辑属于破坏性编辑，必须可撤销。

规则：

- 永远不改原始视频文件。
- 每次 apply 前保存 undo snapshot。
- 删除比例超过 45% 时默认 `review_required`。
- AI confidence 低于阈值的删除只标记候选，不自动删除。
- 用户明确说“直接剪”时可以自动 apply，但仍保留 undo。
- 所有删除片段必须可在 review list 中查看 reason。

## Implementation Steps

### Step 1: Contract And Skill

Files:

- `desktop/shared/videoAutoCut.ts`
- `desktop/builtin-skills/redbox-video-autocut/SKILL.md`
- `desktop/prompts/library/runtime/agents/video_editor/base.txt`

Work:

- 定义 `AutoCutInput`、`AutoCutResult`、`TranscriptSegment`、`EditDecisionList`。
- 新增 skill，要求只调用 `video_editor.auto_cut`。
- 更新 video editor agent prompt，让它识别自动剪辑需求。

Acceptance:

- TypeScript 类型可被 renderer 和 shared adapter 引用。
- skill 明确 “不要自己写 ffmpeg 命令，不要直接写 timeline”。

### Step 2: Host Command Skeleton

Files:

- `desktop/src-tauri/src/commands/video_auto_cut.rs`
- `desktop/src-tauri/src/video_auto_cut/mod.rs`
- `desktop/src-tauri/src/video_auto_cut/types.rs`
- `desktop/src-tauri/src/main.rs`
- `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src/types.d.ts`

Work:

- 注册 `video_editor:auto-cut` channel。
- 支持 `video_editor.run(auto_cut)` action。
- 返回 job result envelope。
- 先不做 UI。

Acceptance:

- renderer 能调用一次真实 IPC。
- 未配置 ASR 时返回明确错误，不 panic。

### Step 3: Probe And ASR

Files:

- `video_auto_cut/probe.rs`
- `video_auto_cut/transcribe.rs`
- existing settings/model slot code

Work:

- 调 ffprobe。
- 抽音频到 job dir。
- 调 transcription endpoint。
- 写 `transcript.json`。

Acceptance:

- 一个本地 mp4 能生成 transcript。
- transcript 文件包含 start/end/text。

### Step 4: Transcript Normalization

Files:

- `video_auto_cut/transcript.rs`

Work:

- 合并过短句。
- 标记 filler、pause、repeat、mistake_candidate。
- 生成字幕候选文本。

Acceptance:

- 包含“嗯、啊、就是、然后”等口播样本能被标记。
- 不直接删除，只标记。

### Step 5: Planner And EDL Validator

Files:

- `video_auto_cut/planner.rs`
- `video_auto_cut/edl.rs`

Work:

- 调现有 AI provider。
- 输出 EDL JSON。
- validator 校验时间区间、删除比例、reason、segmentIds。
- fallback 到规则清理。

Acceptance:

- AI 输出坏 JSON 时可恢复。
- EDL 不会删除整个视频。

### Step 6: Timeline Apply

Files:

- `video_auto_cut/timeline.rs`
- `desktop/shared/videoAutoEdit.ts` or successor shared timeline contract
- existing manuscript package / editor project code

Work:

- 创建或打开 `.redvideo` project。
- 生成 primary video track。
- 按 EDL 生成 clip list。
- 生成 undo snapshot。
- 写 auto cut run record。

Acceptance:

- 剪辑结果在视频编辑器里可继续编辑。
- 原视频不被修改。

### Step 7: Subtitle Track

Files:

- `video_auto_cut/subtitles.rs`
- existing Remotion / subtitle preset code

Work:

- 按 output timeline 重新映射字幕时间。
- 生成 SRT。
- 生成 subtitle track / Remotion overlay。

Acceptance:

- 删除片段后字幕不漂移。
- 预览中字幕跟随剪辑后时间线。

### Step 8: Minimal UI

Files:

- `desktop/src/components/manuscripts/VideoDraftWorkbench.tsx`
- `desktop/src/features/video-editor/store/useVideoEditorStore.ts`
- maybe `desktop/src/components/manuscripts/AutoCutPopover.tsx`

Work:

- 加一个 `自动粗剪` 按钮。
- 弹出最小参数面板。
- 展示 host progress。
- 完成后刷新 timeline。
- 保留 undo。

Acceptance:

- 用户上传视频后两步内启动自动剪辑。
- 失败不清空已有页面状态。

### Step 9: Chat / RedClaw Integration

Files:

- `desktop/src-tauri/src/tools/app_cli.rs`
- `desktop/src-tauri/src/tools/families/editor.rs`
- `desktop/src-tauri/src/tools/registry.rs`
- runtime skill activation code

Work:

- 让 `Redbox(resource="video_editor", operation="run", input={ workflow: "auto_cut" })` 路由到同一 host command。
- skill 激活后只暴露必要 action。
- 返回结构化 artifact refs。

Acceptance:

- Chat 中给视频文件和目标，AI 能调用 auto cut workflow。
- RedClaw 任务也能使用同一入口。

### Step 10: Verification Matrix

Samples:

- 30s 口播：语气词、长停顿、重复句。
- 3min 口播：目标缩短到 60s。
- 教程视频：保留关键步骤，生成字幕。
- 无音频视频：返回 scene-based 降级说明。
- ASR 配置缺失：返回可操作错误。

Commands:

```text
pnpm -C desktop exec tsc --noEmit
pnpm -C desktop exec vite build
cargo test -p redbox-desktop video_auto_cut
```

Manual checks:

- 原始视频未修改。
- timeline 可撤销。
- 字幕不漂移。
- 删除原因可查看。
- 页面刷新保留最后成功状态。

## Comparison Of Approaches

| Approach | Description | Pros | Cons | Recommendation |
| --- | --- | --- | --- | --- |
| Single black-box auto-cut tool | 一个工具直接输入视频输出 MP4 | 最快 | 不可编辑，不可审计，难复用 | 不推荐 |
| Many exposed micro tools | 给模型暴露 probe/transcribe/plan/apply/render | 灵活 | 工具面膨胀，模型容易误用 | 不推荐作为默认 |
| One public workflow, internal services | 模型只调 `video_editor.auto_cut`，host 内部拆步骤 | 简洁、可测、可恢复、可扩展 | 需要设计好 schema | 推荐 |
| Full Pixelle-style pipeline | topic/asset 到完整生成视频 | 适合批量生成新视频 | 不适合剪用户上传视频 | 只借鉴任务和中间产物设计 |

## Open Questions

- 现有 ASR 是否稳定提供 word-level timestamps；如果没有，第一版删除精度会受限。
- `.redvideo` project 是否继续沿用现有 manuscript package schema，还是把 V2 auto cut project store 重新迁回主线。
- 字幕第一版使用 SRT layer 还是 Remotion overlay 作为唯一真相。
- 是否需要一个 lightweight review list，还是只通过 timeline selection 展示删除原因。

## Done Criteria

该计划完成的标准：

- 用户从视频稿件编辑器上传口播视频后，可启动自动粗剪。
- 系统生成 transcript、EDL、subtitle、editable timeline。
- 删除语气词、口误、长停顿可复盘。
- 用户能预览、撤销、继续手动编辑。
- Chat / RedClaw 能通过同一个 skill 和 workflow 调用。
- 无 ASR / ffmpeg / provider 配置时错误清晰。
- 验证覆盖真实 renderer IPC、host command、AI planner fallback、timeline apply 和字幕时间映射。
