---
title: RedConvert 自动剪辑与视频工作台接入实施方案
doc_type: plan
execution_status: not_started
execution_stage: draft_approved_waiting_execution
last_updated: 2026-04-21
owner: codex
target_files:
  - desktop/electron/core/video-auto-edit/
  - desktop/electron/preload.ts
  - desktop/electron/main.ts
  - desktop/electron/core/tools/appCliTool.ts
  - desktop/shared/videoAutoEdit.ts
  - desktop/src/components/manuscripts/ExperimentalVideoWorkbench.tsx
  - desktop/src/components/manuscripts/VideoDraftWorkbench.tsx
  - desktop/src/pages/Manuscripts.tsx
success_metrics:
  - 可从视频项目一键生成可编辑粗剪时间线
  - 可生成基础剪辑产物并回写到视频项目包
  - 用户可在现有时间线中继续手工编辑，不需要切换到独立工具
---

# RedConvert 自动剪辑与视频工作台接入实施方案

## 1. 目标定义

本方案的目标不是再做一个独立的“AI 视频生成器”，而是在 RedConvert 现有视频项目和时间线编辑器之上，补齐一条完整的自动剪辑主链路：

1. 导入现有素材或使用项目内已绑定素材。
2. 自动分析视频、图片、音频素材。
3. 根据脚本或主题生成分镜节拍。
4. 从素材中挑选候选片段并生成粗剪时间线。
5. 用 `ffmpeg` 输出基础剪辑产物。
6. 将结果直接写回现有 `EditorProjectFile`、`videoProject`、`packageState`。
7. 在现有视频工作台中继续手工精修、加字幕、加动画、导出。

这意味着自动剪辑模块的职责是“生成初始可编辑工程”，不是替代现有编辑器。

## 2. 为什么采用这条路线

当前仓库已经具备以下可复用底座：

- 视频项目包与素材目录管理：
  - `desktop/electron/core/videoProjectStore.ts`
- 生视频素材接入与项目资产写回：
  - `desktop/electron/core/videoGenerationService.ts`
  - `desktop/electron/core/tools/appCliTool.ts`
- 可编辑时间线与工程结构：
  - `desktop/src/components/manuscripts/editorProject.ts`
- 视频工作台与基础剪辑占位状态：
  - `desktop/src/components/manuscripts/ExperimentalVideoWorkbench.tsx`
  - `desktop/src/components/manuscripts/VideoDraftWorkbench.tsx`

因此最优方案不是平行新增一套 Pixelle 式流水线，而是把 Pixelle 的“分镜驱动装配”思路，改造成适配 RedConvert 的“粗剪工程生成器”。

## 3. 产品形态

### 3.1 用户可见能力

在视频工作台中新增一组能力：

- `分析素材`
- `生成粗剪时间线`
- `重做选片`
- `生成基础剪辑`
- `从脚本重建节拍`
- `锁定某些片段后局部重剪`

### 3.2 两种工作模式

#### A. Script-first Auto Edit

适用场景：

- 用户已经有脚本。
- 用户已绑定视频、图片、音频素材。
- 目标是自动从素材里生成粗剪初稿。

主链路：

`脚本 -> 节拍拆分 -> 素材分析 -> 候选片段打分 -> 时间线装配 -> 基础剪辑`

#### B. Asset-first Auto Edit

适用场景：

- 用户只有素材，没有脚本。
- 希望 AI 先给出结构化叙事，再自动剪成初稿。

主链路：

`素材分析 -> 素材摘要 -> LLM 生成脚本与节拍 -> 候选片段打分 -> 时间线装配 -> 基础剪辑`

推荐先上线 A，再做 B。A 模式与当前 Manuscripts 工作流最贴合，回报最高，风险最低。

## 4. 技术总架构

### 4.1 总体分层

新增目录：

`desktop/electron/core/video-auto-edit/`

建议模块拆分如下：

1. `types.ts`
2. `videoAutoEditOrchestrator.ts`
3. `videoAssetAnalysisService.ts`
4. `videoTranscriptionService.ts`
5. `videoBeatPlannerService.ts`
6. `videoCandidateSelector.ts`
7. `videoTimelineAssembler.ts`
8. `videoBaseRenderService.ts`
9. `videoAutoEditStore.ts`

共享协议：

`desktop/shared/videoAutoEdit.ts`

### 4.2 数据流

完整数据流：

1. 从 `videoProjectStore` 读取项目、素材、脚本。
2. `videoAssetAnalysisService` 生成素材分析缓存。
3. `videoBeatPlannerService` 产出结构化节拍 `beats[]`。
4. `videoCandidateSelector` 为每个 beat 输出候选片段。
5. `videoTimelineAssembler` 生成 `EditorProjectFile`。
6. `videoBaseRenderService` 根据时间线生成基础剪辑 mp4。
7. `videoAutoEditOrchestrator` 把结果写回：
   - `packageState.videoProject`
   - `packageState.editorProject`
   - `packageState.timelineSummary`
   - `videoProject.baseMedia`
   - `videoProject.ffmpegRecipeSummary`

## 5. 模块设计与实现细节

## 5.1 `types.ts`

职责：

- 统一自动剪辑相关的内部类型。
- 避免 `main.ts`、renderer、tool 侧各自拼对象。

核心类型建议：

```ts
export type AutoEditMode = 'script-first' | 'asset-first';

export type AssetAnalysisType = 'video' | 'image' | 'audio';

export interface VideoShotCandidate {
  id: string;
  assetId: string;
  sourcePath: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  transcriptText?: string;
  visualSummary?: string;
  motionSummary?: string;
  tags: string[];
  scoreHints?: Record<string, number>;
}

export interface AutoEditBeat {
  id: string;
  order: number;
  title: string;
  objective: string;
  narrationText: string;
  desiredDurationMs: number;
  requiredVisuals: string[];
  preferredAssetKinds: Array<'video' | 'image'>;
  lockedCandidateId?: string | null;
}

export interface AutoEditPlan {
  mode: AutoEditMode;
  beats: AutoEditBeat[];
  totalDurationMs: number;
  sourceScript: string;
}

export interface AutoEditTimelineResult {
  editorProject: EditorProjectFile;
  timelineSummary: Record<string, unknown>;
  ffmpegRecipeSummary: string;
  baseMediaOutputPath?: string | null;
}
```

这些类型必须进入 shared 或 core 的单一协议层，不允许 renderer 自己推断。

## 5.2 `videoAssetAnalysisService.ts`

职责：

- 读取素材基础元数据。
- 做镜头级切分。
- 做静音检测。
- 抽关键帧。
- 为后续匹配提供可缓存的候选片段。

### 输入

- `videoProjectId`
- 项目内 clips / references / outputs
- 外部绑定素材

### 输出

- `AssetAnalysisRecord[]`
- `VideoShotCandidate[]`

### 必须使用现成库

- `ffprobe`：时长、尺寸、编码、fps、音频流、旋转信息。
- `ffmpeg`：关键帧抽取、scene detect、silence detect、proxy 生成。

### 不建议第一版自研的能力

- 不要先上 OpenCV 自己做镜头检测。
- 不要先上 PySceneDetect 独立 Python 依赖。

### 第一版实现建议

1. 用 `ffprobe -show_streams -show_format` 抽基础元数据。
2. 用 `ffmpeg` `select='gt(scene,0.25)'` 先做轻量镜头切分。
3. 用 `silencedetect` 标记静音段，给口播类素材降权。
4. 每个候选段抽 1 到 3 张关键帧缩略图，供 UI 预览。
5. 对长视频做 proxy，供工作台快速预览。

### 缓存规则

- 按文件绝对路径 + 文件尺寸 + 修改时间 + hash 生成缓存 key。
- 结果落在视频项目目录下，例如：
  - `analysis/asset-index.json`
  - `analysis/shots/<asset-id>.json`
  - `analysis/thumbs/*.jpg`

## 5.3 `videoTranscriptionService.ts`

职责：

- 为视频候选片段生成转录文本。
- 复用现有转录设置，不单独新增一套配置。

### 复用点

现有主进程已有转录配置和 `transcribeVideoToText` 雏形，可直接下沉重用：

- `transcription_model`
- `transcription_endpoint`
- `transcription_key`

### 第一版策略

1. 对完整视频先抽音频。
2. 跑一次全文转录。
3. 通过时间戳把 transcript 映射回 shot candidates。

### 输出

- `TranscriptSegment[]`
- 每个 candidate 上挂：
  - `transcriptText`
  - `keywords`
  - `speechDensity`

### 注意

- 转录是慢操作，必须可跳过。
- 素材分析界面里要明确展示“已转录 / 未转录 / 转录失败”。

## 5.4 `videoBeatPlannerService.ts`

职责：

- 把脚本或主题转成结构化分镜节拍。
- 这是自动剪辑的大脑，不做素材执行。

### 输入

- 模式：`script-first` / `asset-first`
- 脚本正文或主题摘要
- 目标时长
- 项目比例
- 素材摘要

### 输出

- `AutoEditPlan`

### 生成策略

#### Script-first

1. 按段落、句子、标点停顿切分脚本。
2. 将段落归并成节拍，避免字幕过碎。
3. 给每个 beat 生成：
   - 叙事目标
   - 预期时长
   - 画面类型要求
   - 关键词

#### Asset-first

1. 汇总素材分析描述。
2. LLM 先生成视频结构草稿。
3. 再生成 beats。

### 必须自研

- Beat 数据结构。
- Prompt 输入与输出协议。
- 脚本切分与节拍归并规则。

### 不推荐做法

- 不要只给 LLM 一段自由文本，让它直接决定完整时间线。
- 必须约束为结构化 beats，后面才能重做某个 beat 的选片。

## 5.5 `videoCandidateSelector.ts`

职责：

- 针对每个 beat，从素材候选段中选最合适的片段。

### 打分维度

每个 beat 对每个 candidate 计算综合分：

- 语义相似度
- 主体匹配度
- 时长匹配度
- 运动强度匹配度
- 画面重复惩罚
- 近邻镜头多样性
- 横竖屏适配损失
- 口播密度与静音惩罚

### 实现建议

第一版可用规则 + 轻量 embedding 混合：

`finalScore = semantic * 0.35 + duration * 0.2 + subject * 0.15 + motion * 0.1 + diversity * 0.1 + aspectFit * 0.1`

### 可重做能力

必须支持：

- 重做某个 beat 的选片。
- 锁定某个 clip，不被后续重算覆盖。
- 用户手动指定 beat 只能用某几个素材。

## 5.6 `videoTimelineAssembler.ts`

职责：

- 把 beats + selected candidates 直接转成现有 `EditorProjectFile`。

这是接入当前 app 的关键，不允许另起一套旁路时间线格式。

### 输出目标

- `EditorAsset[]`
- `EditorTrack[]`
- `EditorItem[]`
- `EditorAnimationLayer[]`
- `Transition[]`

### 推荐默认轨道

- `V1`: 主视频轨
- `V2`: B-roll / 补画面轨
- `A1`: 原音 / 环境音
- `A2`: 配音 / 口播
- `S1`: 字幕轨
- `T1`: 标题文字轨
- `M1`: 动效轨

### 装配逻辑

1. 每个 beat 产出至少一个视频或图片 item。
2. 若某段没有可用视频，允许降级为图片或 freeze frame。
3. 字幕 item 与 narrationText 同步生成到 `S1`。
4. 标题、章节卡、转场预设写入 `T1/M1`。
5. 默认只插轻量转场，第一版不要堆复杂特效。

### 与现有结构对齐

必须复用这些既有能力：

- `buildRemotionCompositionFromEditorProject`
- `deriveLegacyTimelineClips`
- `deriveProjectedEditorItems`

目标是让工作台打开后无需做二次转换。

## 5.7 `videoBaseRenderService.ts`

职责：

- 用 `ffmpeg` 生成基础粗剪视频。

### 这一层要做什么

- 素材裁切
- 时间线拼接
- 尺寸适配
- 主轨 / 副轨混合
- 原声音量 ducking
- 配音叠加
- 可选字幕 burn-in 预览

### 必须使用现成库

- `ffmpeg`
- `ffprobe`

### 第一版渲染目标

先做稳定的 `基础剪辑`，不要一开始把所有文字图层都烤进视频。

推荐分两层：

1. `baseMedia`
   - 纯视频 + 音频粗剪结果
2. `Remotion overlay`
   - 标题
   - 字幕
   - 贴纸
   - 图形动效

这样能完全复用你们现有工作台里“先基础剪辑，再 Remotion 叠加”的思路。

### 输出写回

- `videoProject.baseMedia.outputPath`
- `videoProject.baseMedia.durationMs`
- `videoProject.baseMedia.status`
- `videoProject.ffmpegRecipeSummary`

## 5.8 `videoAutoEditOrchestrator.ts`

职责：

- 编排整条流水线。
- 管状态。
- 管失败恢复。
- 对外给 IPC / Tool 暴露单一入口。

### 对外暴露的方法

- `analyzeProjectAssets(projectId)`
- `buildAutoEditPlan(projectId, options)`
- `regenerateBeat(projectId, beatId, options)`
- `assembleTimeline(projectId, planId)`
- `renderBaseMedia(projectId, options)`

### 状态管理

建议新增项目级状态：

```ts
videoProject.autoEdit = {
  mode: 'script-first',
  analysisStatus: 'idle' | 'running' | 'completed' | 'failed',
  planStatus: 'idle' | 'running' | 'completed' | 'failed',
  renderStatus: 'idle' | 'running' | 'completed' | 'failed',
  lastPlanId: string | null,
  lastError: string | null,
  updatedAt: number | null,
}
```

## 6. IPC 与主进程接线

## 6.1 新增 IPC

在 `preload.ts` 和 `main.ts` 新增结构化 API：

- `video:auto-edit-analyze`
- `video:auto-edit-build`
- `video:auto-edit-regenerate-beat`
- `video:auto-edit-render-base`
- `video:auto-edit-get-status`

### 规则

- `main.ts` 只负责接线。
- 业务逻辑全部下沉到 `desktop/electron/core/video-auto-edit/*`。

## 6.2 Tool 层接入

在 `appCliTool.ts` 增加：

- `video auto-edit-analyze`
- `video auto-edit-build`
- `video auto-edit-render`

这样现有 AI runtime 就能直接驱动自动剪辑，不需要专门写第二套 agent 接口。

## 7. UI 实施方案

这部分是本计划最关键的落地内容。

## 7.1 接入位置

优先接入：

- `desktop/src/components/manuscripts/ExperimentalVideoWorkbench.tsx`
- `desktop/src/components/manuscripts/VideoDraftWorkbench.tsx`
- `desktop/src/pages/Manuscripts.tsx`

不建议先做独立页面。自动剪辑必须与现有视频工作台同屏协作。

## 7.2 UI 目标

用户在一个界面里完成：

1. 选择模式
2. 查看素材分析
3. 查看 beat 列表
4. 查看每个 beat 的已选片段和备选片段
5. 生成时间线
6. 生成基础剪辑
7. 在现有时间线继续编辑

## 7.3 推荐布局

### 左侧：自动剪辑侧栏

新增一个 `Auto Edit` 面板，包含：

- 模式切换：
  - `按脚本粗剪`
  - `按素材自动成片`
- 参数区：
  - 目标时长
  - 比例
  - 节奏偏好
  - 是否优先口播同步
  - 是否允许使用图片补位
- 按钮区：
  - `分析素材`
  - `生成节拍`
  - `生成粗剪时间线`
  - `生成基础剪辑`

### 中间：Beat 列表

每个 beat 显示：

- 节拍标题
- narration 文本
- 目标时长
- 当前已选素材
- 候选素材缩略图列表
- `重做选片`
- `锁定当前片段`
- `插入为 B-roll`

### 右侧：现有预览区

继续复用你们当前的：

- 原素材/基础剪辑预览
- Remotion 预览
- 导出按钮

### 下方：现有时间线

继续复用当前 `EditableTrackTimeline` / `VendoredFreecutTimeline`。

自动剪辑完成后，用户可以直接拖拽、裁切、替换、改字幕。

## 7.4 UI 状态规则

必须遵守现有 stale-while-revalidate 规则：

- 已有 beat 列表时，刷新分析不能清空 UI。
- 已有时间线时，重新分析素材不能让整个工作台回到空 loading。
- `生成基础剪辑` 失败时，必须保留现有时间线与上一次成功输出。

## 7.5 关键交互

### 分析素材

点击后：

- 显示项目素材总数、已分析数、失败数。
- 支持逐素材展开看：
  - 时长
  - 尺寸
  - 转录状态
  - 镜头数
  - 缩略图

### 生成节拍

点击后：

- 在 beat 列表中渲染结构化分镜。
- 支持单条 beat 手动改文案。
- 支持锁定某条 beat 的目标时长。

### 生成粗剪时间线

点击后：

- 把装配结果直接写入当前编辑器工程。
- 时间线中自动生成：
  - 视频片段
  - 字幕轨
  - 必要文字卡
  - 基础转场

### 重做选片

必须支持两种粒度：

1. 重做单个 beat
2. 重做整个时间线但保留用户锁定片段

### 生成基础剪辑

点击后：

- 后台触发 `ffmpeg` 渲染。
- 在右侧显示：
  - 渲染进度
  - 产物路径
  - recipe 摘要

## 7.6 UI 组件建议

建议新增组件：

- `AutoEditPanel.tsx`
- `AutoEditBeatList.tsx`
- `AutoEditBeatCard.tsx`
- `AutoEditCandidateStrip.tsx`
- `AutoEditAnalysisDrawer.tsx`
- `AutoEditStatusBadge.tsx`

其中：

- `AutoEditPanel` 管模式与参数。
- `AutoEditBeatList` 管 beats。
- `AutoEditCandidateStrip` 管候选素材缩略条。
- `AutoEditAnalysisDrawer` 看素材分析明细。

## 8. 与现有编辑器模型的映射

## 8.1 工程文件

自动剪辑最终必须产出：

`EditorProjectFile`

不要再引入独立 timeline schema 作为长期存储格式。

## 8.2 packageState 写回策略

建议写回：

```ts
packageState.videoProject = {
  ...existing,
  scriptBody,
  scriptApproval,
  baseMedia,
  ffmpegRecipeSummary,
  remotion,
  autoEdit,
}

packageState.editorProject = editorProject;
packageState.timelineSummary = deriveLegacyTimelineClips(editorProject);
```

## 8.3 兼容已有功能

必须确保不破坏：

- 手工拖素材到底部轨道开始剪辑
- 生成 Remotion 场景
- 现有导出链路
- 已存在的视频项目包

## 9. 性能与工程策略

## 9.1 必做优化

- 分析缓存按素材 hash 命中。
- 抽帧、转录、镜头检测放 worker 或子进程。
- 大视频先生成 proxy。
- concat 能 copy 就 copy，不必要不重编码。
- beat 重算支持局部刷新，不全量重建时间线。

## 9.2 锁与状态

遵守仓库已有 Store Lock Rule：

- 锁内只读最小快照。
- 文件扫描、转录、ffmpeg 任务全在锁外。
- 最终只把结果写回内存和 manifest。

## 9.3 可观测性

建议记录：

- 每个分析任务耗时
- 每个 beat 的候选数和最终分数
- `ffmpeg` recipe
- 渲染失败 stderr 摘要

## 10. 必须复用与必须自研

## 10.1 必须复用

- `ffmpeg` / `ffprobe`
- 现有转录配置与主进程转录能力
- `videoProjectStore`
- `EditorProjectFile`
- 现有时间线与 Remotion 工作台

## 10.2 必须自研

- beat 结构
- candidate selector 打分
- timeline assembler
- auto-edit 状态机
- beat 级局部重算能力
- 工作台内自动剪辑 UI

## 11. 执行顺序

虽然最终交付是完整能力，但开发顺序必须合理，避免返工。

### Step 1

实现分析链路：

- `types.ts`
- `videoAssetAnalysisService.ts`
- `videoTranscriptionService.ts`
- `videoAutoEditOrchestrator.analyzeProjectAssets`

### Step 2

实现规划与装配：

- `videoBeatPlannerService.ts`
- `videoCandidateSelector.ts`
- `videoTimelineAssembler.ts`

### Step 3

实现工作台 UI：

- 自动剪辑侧栏
- beat 列表
- 候选素材条
- 局部重做

### Step 4

实现基础粗剪渲染：

- `videoBaseRenderService.ts`
- `video:auto-edit-render-base`
- 工作台中的基础剪辑状态展示

### Step 5

接 AI tool：

- `appCliTool.ts`
- `redbox_editor` 相关提示词与操作建议

## 12. 验收标准

达到以下条件才算完成：

1. 用户在视频草稿中点击“分析素材”，能看到结构化素材分析结果。
2. 用户在已有脚本情况下，能一键生成可编辑粗剪时间线。
3. 时间线结果直接进入现有编辑器，不需要额外转换。
4. 用户能对单个 beat 重做选片，而不是每次全部重建。
5. 用户能生成基础剪辑 mp4，并在工作台中继续叠加 Remotion 内容。
6. 自动剪辑失败时，已有时间线和上一次成功产物不会被清空。

## 13. 风险与规避

### 风险 1：分析太慢

规避：

- 先做缓存。
- 先分析项目内主素材，不全量扫所有媒体库。

### 风险 2：LLM 规划不稳定

规避：

- 强制输出 beats 结构化 JSON。
- 不允许 LLM 直接返回完整时间线命令。

### 风险 3：粗剪结果不可编辑

规避：

- 以 `EditorProjectFile` 为唯一工程格式。
- 时间线写回后必须能立即在现有工作台中拖拽编辑。

### 风险 4：主进程卡顿

规避：

- 所有 `ffmpeg`、转录、抽帧、镜头分析都走异步后台任务。

## 14. 推荐最终定位

这个模块在产品中的定位应为：

**AI 粗剪引擎**

不是：

- 独立成片器
- 另一个视频生成页面
- 只能输出 mp4 的黑盒

它的价值是把“主题 / 脚本 / 素材”快速转成一个可继续编辑的视频工程，直接增强 RedConvert 现有视频编辑能力。
