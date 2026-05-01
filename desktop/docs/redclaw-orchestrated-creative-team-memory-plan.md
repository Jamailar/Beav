---
doc_type: plan
execution_status: in_progress
last_updated: 2026-05-01
---

# RedClaw Orchestrated Creative Team And Memory Plan

## Goal

把 RedClaw 从“用户手动点功能的 AI 页面”升级为“自动组建创作团队的内容生产系统”。

用户只需要在 RedClaw 页面发出目标，例如：

- 基于最近收藏，做一条小红书口播视频。
- 把这个灵感扩展成完整发布包。
- 从我的知识库里找 5 个值得做的选题，并完成第一条。
- 复盘最近 10 条内容，给我下周内容计划。

RedClaw 应自动完成：

1. 理解用户目标。
2. 生成任务图。
3. 自动选择需要的角色 Agent。
4. 为每个 Agent 注入最小必要上下文。
5. 调用稳定 Skill 和 Tool 执行。
6. 把结果写入项目状态。
7. 统一记录事件、反馈、表现数据。
8. 由学习管线沉淀到统一 Memory Core。

核心原则：

```text
RedClaw 在进化。
Agent 是 RedClaw 调度出来的临时岗位。
Skill 是岗位调用的方法。
Tool 是真实副作用边界。
Memory 是 RedClaw 统一治理的经验资产。
```

## Recommended Direction

推荐采用“统一 RedClaw 大脑 + 临时角色 Agent + 可进化 Skill + 集中 Memory Core”的架构。

不要让每个 Agent 自由拥有完整记忆，也不要让 Skill 自己改写自身文件。Agent 每次运行时由 RedClaw 注入上下文，执行完只提交结构化输出、观察和学习候选。Memory Manager 负责判断哪些经验可以写入长期记忆。

### Option Comparison

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. 单一大 Agent | RedClaw 用一个超级助手完成研究、脚本、媒体、发布、复盘 | 实现最快，调度简单 | 输出不稳定，难解释，难评估，无法精细学习 | 不推荐 |
| B. 多 Agent 各自持有记忆 | 每个 Agent 自己读写自己的 memory 和 skill 偏好 | 岗位专业感强 | 记忆碎片化，偏好冲突，用户要重复纠正，长期会乱 | 不推荐 |
| C. 统一 Memory Core + 临时角色 Agent | RedClaw 统一组队、统一记忆、统一学习；Agent 按角色读取切片 | 一致性好，可审计，可演进，可控 | 需要设计 TaskGraph、EventLog、MemoryManager | 推荐 |
| D. 只用 Skill 不设角色 | Orchestrator 直接按任务调用 Skill | 稳定、测试容易 | 缺少岗位职责、计划判断、跨步骤协作 | 可作为底层，不适合作为产品心智 |

最终选择：**C 为主，D 作为底层能力组织方式**。

## Product Shape

RedClaw 页面需要从单一聊天页演化为通用创作协作入口，但不为小红书、视频或其他内容形态拆专属页面。第一屏仍然是用户熟悉的任务输入，平台差异由 Orchestrator、角色团队、Skill contract、导出包和质检层承载。

推荐一级区域：

```text
RedClaw Page
├── Command Bar            用户发起目标
├── Team Run Timeline      当前自动组队和执行状态
├── Creation Workspace     当前项目成果：brief/script/storyboard/media/publish
├── Evidence And Memory    引用资料、素材、用户偏好、策略依据
└── Review And Learnings   质检、复盘、可保存的长期偏好
```

用户不需要手动选择 Research Agent 或 Script Agent。页面只展示：

- RedClaw 正在做什么。
- 哪些岗位参与了。
- 每个岗位产出了什么。
- 当前缺什么。
- 下一步建议是什么。
- 哪些学习项可以保存为长期偏好。

小红书文章、图文和配图流程不新增专属 UI。用户仍在 RedClaw 页面发任务、看团队协作和领取交付物；系统内部根据 `contentFormat` 自动组建 Topic、Note Architect、Copy、Visual、Image、Layout、Compliance 等临时岗位。

## End-To-End Flow

### Example Task

用户输入：

```text
基于最近收藏的内容，做一条适合小红书的 60 秒口播视频，并给我标题、封面文案和发布正文。
```

系统流程：

```text
User Task
  -> Intent Parser
  -> Team Planner
  -> Task Graph
  -> Context Builder
  -> Agent Runner
  -> Skill Runner
  -> Tool Runtime
  -> Project State Machine
  -> Review Agent
  -> Event Log
  -> Learning Pipeline
  -> Memory Manager
```

对应岗位：

```text
Research Agent
  找最近收藏、提炼参考内容和证据

Insight Agent
  选择角度、目标人群、平台适配理由

Script Agent
  生成 60 秒口播脚本和 hook 变体

Storyboard Agent
  拆分镜、镜头需求、字幕节奏

Media Agent
  匹配本地素材、生成粗剪计划

Publish Agent
  生成标题、封面文案、正文、标签

Review Agent
  检查人设一致性、平台适配、事实支撑、制作可行性
```

## Core Architecture

```text
desktop/src/pages/RedClaw.tsx
  -> RedClaw command and workspace shell

desktop/src/pages/redclaw/orchestration/*
  -> task run UI, team timeline, project state panels

desktop/src/bridge/ipcRenderer.ts
  -> redclaw orchestration IPC facade

desktop/src-tauri/src/commands/redclaw_orchestration.rs
  -> command boundary

desktop/src-tauri/src/redclaw/orchestrator/*
  -> planner, task graph, runner, state machine

desktop/src-tauri/src/redclaw/agents/*
  -> AgentSpec registry and role prompts

desktop/src-tauri/src/redclaw/skills/*
  -> RedClaw skill registry, schema, evaluation hooks

desktop/src-tauri/src/redclaw/memory/*
  -> Memory Core, event log, learning pipeline, write policy

desktop/src-tauri/src/redclaw/media/*
  -> media probe, transcribe, scene detection, timeline plan

desktop/src-tauri/src/redclaw/persistence/*
  -> SQLite stores, project state, run records, memory records
```

`main.rs` 只做装配和路由接线。业务逻辑必须下沉到 `commands/*`、`redclaw/*`、`runtime/*` 或 `persistence/*`。

## Module Plan

### 1. RedClaw Orchestrator

职责：

- 接收用户自然语言任务。
- 读取当前 RedClaw 页面上下文和项目状态。
- 生成 `TaskGraph`。
- 决定需要哪些 Agent。
- 控制节点依赖、并发、重试、取消。
- 所有项目状态写入都经由 Project State Machine。

关键数据结构：

```ts
type RedClawRun = {
  id: string
  userTask: string
  projectId?: string
  status: 'pending' | 'running' | 'waiting_user' | 'succeeded' | 'failed' | 'cancelled'
  graphId: string
  createdAt: string
  updatedAt: string
}

type TaskGraph = {
  id: string
  goal: string
  nodes: TaskNode[]
  edges: TaskEdge[]
}

type TaskNode = {
  id: string
  agentId: RedClawAgentId
  skillIds: string[]
  input: unknown
  outputSchema: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  requiredArtifacts: string[]
}

type TaskEdge = {
  from: string
  to: string
  dependencyType: 'requires_output' | 'requires_review' | 'optional_context'
}
```

实现要点：

- Team Planner 可以用 AI 生成初稿，但必须经过 schema 校验和 deterministic repair。
- TaskGraph 中的节点必须是有限枚举，不允许模型自由创建未知 agent/tool。
- 并行只允许无依赖节点，例如 Research 和 Knowledge Retrieval 可以并行；Script 必须等 Brief。
- 节点失败后，Orchestrator 决定降级、重试或请求用户确认。

### 2. Agent Registry

Agent 是角色岗位，不是独立人格和独立记忆库。

AgentSpec：

```ts
type AgentSpec = {
  id:
    | 'research_agent'
    | 'insight_agent'
    | 'script_agent'
    | 'storyboard_agent'
    | 'media_agent'
    | 'editor_agent'
    | 'publish_agent'
    | 'review_agent'
  mission: string
  responsibilities: string[]
  allowedSkills: string[]
  allowedTools: string[]
  readableMemoryScopes: MemoryScope[]
  writableEventTypes: RedClawEventType[]
  inputSchema: string
  outputSchema: string
  qualityChecklist: string[]
  escalationRules: string[]
}
```

推荐 Agent 职责：

| Agent | 主要职责 | 不允许做的事 |
|---|---|---|
| Research Agent | 查资料、提炼证据、补全上下文 | 不直接写最终脚本 |
| Insight Agent | 找选题、定角度、评分 | 不生成完整发布包 |
| Script Agent | 生成脚本、正文、结构变体 | 不直接写长期记忆 |
| Storyboard Agent | 拆分镜、镜头、字幕节奏 | 不调用 ffmpeg 渲染 |
| Media Agent | 素材匹配、粗剪计划、时间线 JSON | 不做策略复盘 |
| Editor Agent | 改稿、一致性、事实风险 | 不覆盖用户确认版本 |
| Publish Agent | 标题、封面文案、标签、发布正文 | 不自动发布平台 |
| Review Agent | 质检、复盘、学习候选 | 不绕过 Memory Manager 写长期记忆 |

### 3. Skill Registry

Skill 是稳定的专业能力包。Skill 本体版本化，学习结果写入 Skill Memory，不直接改 skill 文件。

SkillProfile：

```ts
type SkillProfile = {
  id: string
  version: string
  domain: 'research' | 'insight' | 'script' | 'storyboard' | 'media' | 'editor' | 'publish' | 'review'
  inputSchema: string
  outputSchema: string
  defaultParams: Record<string, unknown>
  applicableContexts: string[]
  evaluationDimensions: string[]
}
```

首批 Skill：

```text
research.collect_recent_references
research.extract_claims
research.summarize_competitor_case

insight.topic_cluster
insight.idea_score
insight.brief_from_references

script.short_video_script
script.xiaohongshu_note
script.hook_variants
script.rewrite_by_voice

storyboard.scene_breakdown
storyboard.shot_list
storyboard.caption_rhythm

media.asset_match
media.rough_cut_plan
media.timeline_from_storyboard

editor.fact_check
editor.voice_consistency
editor.production_readiness

publish.title_variants
publish.cover_copy
publish.platform_package

review.run_quality_review
review.performance_analysis
review.learning_candidate_extract
```

### 4. Tool Runtime

Tool 是真实操作边界，必须 small、predictable、structured、composable。

优先复用现有顶层工具面：

- `app_cli`：RedClaw 业务 action。
- `redbox_fs`：文件、素材、workspace 能力。
- `bash`：受控命令和诊断。
- `redbox_editor`：编辑器协议。

RedClaw 不新增一堆业务顶层 tool。新增能力优先作为 canonical action：

```text
app_cli.redclaw.project.create
app_cli.redclaw.project.patch
app_cli.redclaw.knowledge.search
app_cli.redclaw.memory.read
app_cli.redclaw.event.append
app_cli.redclaw.media.probe
app_cli.redclaw.media.transcribe
app_cli.redclaw.media.match_assets
app_cli.redclaw.timeline.create_plan
```

所有 tool 输入输出必须是 JSON schema，不接受自然语言协议。

### 5. Memory Core

Memory 按业务对象存，不按 Agent 私有脑袋存。

```text
RedClaw Memory Core
├── Creator Memory
├── Platform Memory
├── Project Memory
├── Skill Memory
├── Knowledge / Asset Memory
├── Execution Memory
└── Learning Candidate Memory
```

#### Creator Memory

保存用户和账号长期偏好。

```ts
type CreatorMemory = {
  creatorId: string
  positioning: string
  audience: string[]
  brandVoice: {
    tone: string[]
    avoidTone: string[]
    preferredOpenings: string[]
    bannedPatterns: string[]
    phraseBank: string[]
    tabooTopics: string[]
  }
  contentPillars: string[]
  updatedAt: string
}
```

写入规则：

- 高影响偏好需要用户确认或强证据。
- 单项目临时要求不自动升格为 Creator Memory。
- 冲突偏好要保留证据并提示用户选择。

#### Platform Memory

保存平台策略和表现学习。

```ts
type PlatformMemory = {
  platform: 'xiaohongshu' | 'douyin' | 'bilibili' | 'youtube' | 'tiktok'
  formatStrategies: Record<string, PlatformFormatStrategy>
  performanceLearnings: PerformanceLearning[]
  updatedAt: string
}
```

#### Project Memory

保存当前项目状态，保证创作连续。

```ts
type ProjectMemory = {
  projectId: string
  goal: string
  platform: string
  format: string
  confirmedDecisions: Decision[]
  rejectedDirections: RejectedDirection[]
  temporaryPreferences: TemporaryPreference[]
  artifacts: {
    brief?: CreativeBrief
    script?: ScriptDocument
    storyboard?: Storyboard
    mediaPlan?: MediaPlan
    publishPackage?: PublishPackage
  }
}
```

#### Skill Memory

保存 Skill 的适用场景、参数偏好和表现，而不是改写 Skill 本体。

```ts
type SkillMemory = {
  skillId: string
  scope: 'global' | 'creator' | 'platform' | 'format'
  preferredParams: Record<string, unknown>
  successPatterns: Pattern[]
  failurePatterns: Pattern[]
  examples: {
    liked: Example[]
    disliked: Example[]
    highPerformance: Example[]
  }
  confidence: number
  evidenceCount: number
  updatedAt: string
}
```

### 6. Context Builder

每个 Agent 运行前，由 Context Builder 构造最小必要上下文，不能把全部记忆塞进 prompt。

读取顺序：

```text
1. User Task
2. Project Memory Summary
3. Creator Memory Summary
4. Platform Memory Summary
5. Relevant Knowledge / Asset Snippets
6. Skill Memory Hints
7. AgentSpec Constraints
```

运行上下文：

```ts
type AgentRuntimeContext = {
  task: TaskNode
  roleSpec: AgentSpec
  projectContext: ProjectMemorySummary
  creatorContext: CreatorMemorySummary
  platformContext: PlatformMemorySummary
  relevantKnowledge: KnowledgeSnippet[]
  skillHints: SkillExecutionHint[]
  constraints: ExecutionConstraint[]
}
```

### 7. Project State Machine

RedClaw 必须把创作产物作为 first-class state，而不是散落在聊天文本里。

推荐状态：

```text
idea
  -> brief_ready
  -> script_ready
  -> storyboard_ready
  -> media_plan_ready
  -> publish_package_ready
  -> reviewed
  -> exported
  -> performance_imported
  -> learned
```

项目 patch：

```ts
type ProjectPatch = {
  projectId: string
  operations: ProjectOperation[]
  reason: string
  confidence: number
  generatedBy: {
    runId: string
    agentId: string
    skillIds: string[]
  }
}
```

项目状态写入规则：

- Agent 不直接改数据库。
- Agent 输出 `ProjectPatch`。
- Orchestrator 校验 schema。
- Project State Machine 应用 patch。
- EventLog 记录差异。
- UI 使用 stale-while-revalidate 显示最新成功快照。

### 8. Event Log

统一事件流是防止记忆变杂的关键。

```ts
type RedClawEvent =
  | { type: 'run.started'; runId: string; task: string }
  | { type: 'task_graph.created'; runId: string; graphId: string }
  | { type: 'agent.started'; runId: string; nodeId: string; agentId: string }
  | { type: 'agent.completed'; runId: string; nodeId: string; outputRef: string }
  | { type: 'skill.used'; runId: string; skillId: string; inputHash: string; outputRef: string }
  | { type: 'project.patch_applied'; projectId: string; patchRef: string }
  | { type: 'user.selected'; targetType: string; targetId: string }
  | { type: 'user.edited'; beforeRef: string; afterRef: string }
  | { type: 'publish.performance_imported'; projectId: string; metricsRef: string }
  | { type: 'learning.candidate_created'; candidateId: string }
  | { type: 'memory.updated'; memoryScope: MemoryScope; memoryId: string }
```

实现要求：

- Event append 必须轻量、结构化、可重放。
- 大 payload 存 artifact/ref，不直接塞事件。
- 所有学习都从 EventLog 推导，不让 Agent 直接写长期 memory。

### 9. Learning Pipeline

学习流程：

```text
EventLog
  -> Signal Extractor
  -> Learning Candidate
  -> Confidence Scoring
  -> Conflict Check
  -> Memory Write Policy
  -> Memory Store
```

LearningCandidate：

```ts
type LearningCandidate = {
  id: string
  scope: 'project' | 'creator' | 'platform' | 'skill' | 'agent_operations'
  statement: string
  evidence: Evidence[]
  confidence: number
  proposedBy: 'review_agent' | 'learning_pipeline' | 'user'
  requiresConfirmation: boolean
  status: 'pending' | 'accepted' | 'rejected' | 'superseded'
}
```

写入策略：

| 目标记忆 | 写入方式 | 证据要求 |
|---|---|---|
| Project Memory | 自动写 | 当前 run 产物或用户确认 |
| Creator Memory | 用户确认或高置信写 | 多次选择、明确表达、低冲突 |
| Platform Memory | Review Agent 提议，表现数据支持 | 发布数据或明确平台规则 |
| Skill Memory | Learning Pipeline 写 | 选择率、编辑距离、发布效果 |
| Agent Operations | 系统写 | 运行失败、质检发现、协作阻塞 |

## AI Implementation Details

### Orchestrator Prompt Boundary

Orchestrator 不直接生成最终作品，它只做：

- 任务理解。
- 任务图生成。
- Agent/Skill 选择。
- 节点依赖。
- 失败处理。
- 汇总用户可见结果。

Orchestrator 输出必须是 `TaskGraph`，不能是自由文本计划。

### Agent Output Boundary

每个 Agent 输出结构化 artifact。

Script Agent 示例：

```ts
type ScriptAgentOutput = {
  projectId: string
  script: {
    title: string
    hook: string
    sections: {
      id: string
      type: 'hook' | 'problem' | 'story' | 'insight' | 'method' | 'cta'
      text: string
      evidenceIds: string[]
      estimatedDurationSec: number
    }[]
  }
  alternatives: {
    hooks: string[]
    titles: string[]
  }
  assumptions: string[]
  missingInputs: string[]
  nextRecommendedAgent?: 'storyboard_agent' | 'media_agent' | 'editor_agent'
}
```

Media Agent 示例：

```ts
type MediaPlan = {
  projectId: string
  requiredShots: RequiredShot[]
  matchedAssets: MatchedAsset[]
  timelinePlan?: Timeline
  missingAssets: MissingAsset[]
  productionRisks: string[]
}
```

Review Agent 示例：

```ts
type ReviewAgentOutput = {
  projectId: string
  qualityScore: {
    overall: number
    voiceMatch: number
    evidenceSupport: number
    platformFit: number
    productionReadiness: number
  }
  blockingIssues: string[]
  suggestedPatches: ProjectPatch[]
  learningCandidates: LearningCandidate[]
}
```

### Model Routing

推荐：

- Orchestrator：强推理模型，低温度，schema 输出。
- Research / Insight：强推理模型，允许引用知识库。
- Script / Publish：创作模型，读取 brand voice 和平台策略。
- Media：工具优先，模型只生成匹配理由和 timeline plan。
- Review：强推理模型，低温度，严格 checklist。

不要用用户消息关键词硬路由。路由依据应来自：

- `runtimeMode`
- `TaskGraph`
- `AgentSpec`
- `inputSchema`
- `project.status`
- `platform`
- `format`

## Video And Media Implementation

RedClaw 应先做 AI rough cut，而不是自研完整 NLE。

媒体流程：

```text
Media Import
  -> ffprobe
  -> proxy generation
  -> transcription
  -> scene detection
  -> asset indexing
  -> storyboard matching
  -> timeline JSON
  -> preview
  -> export
```

必须用现成库：

| 能力 | 推荐库/工具 | 原因 |
|---|---|---|
| 视频探测 | `ffprobe` | 标准稳定 |
| 转码/裁剪/合成 | `ffmpeg` | 不自研编码器 |
| 转写 | Whisper / faster-whisper / OpenAI transcription | ASR 不自研 |
| 静音检测 | Silero VAD / WebRTC VAD | 成熟稳定 |
| 镜头切分 | PySceneDetect | 避免自研场景检测 |
| 模板视频 | Remotion | React 生态友好 |
| 字幕烧录 | ffmpeg + ASS | 成熟 |

需要自研：

- RedClaw `Timeline` JSON。
- 脚本段落到镜头需求的映射。
- 素材匹配策略。
- 粗剪计划生成。
- 项目媒体状态。
- UI 预览和导出任务队列。

Timeline：

```ts
type Timeline = {
  id: string
  tracks: TimelineTrack[]
  durationMs: number
  aspectRatio: '9:16' | '1:1' | '16:9'
}

type TimelineClip = {
  id: string
  assetId: string
  trackId: string
  startMs: number
  endMs: number
  sourceInMs: number
  sourceOutMs: number
  captions?: CaptionSegment[]
  transform?: ClipTransform
  effects?: Effect[]
}
```

## UI Implementation Details

RedClaw 页面应展示自动团队执行，而不是要求用户手动管理 Agent。页面保持通用协作壳，不为小红书单独做专属 UI；小红书的文章、图文、配图差异由 `contentFormat`、任务图、角色输出 schema 和导出包表达。

### Command Bar

职责：

- 接收自然语言任务。
- 支持选择当前项目/平台/格式。
- 支持附加素材或引用灵感。

### Team Run Timeline

展示：

- 当前 RedClaw Run。
- 任务图节点状态。
- 每个角色岗位的产出摘要。
- 等待用户确认的节点。
- 失败和重试入口。

不要把 Agent 内部推理写进 UI。只展示对用户决策有用的状态。

### Creation Workspace

按 artifact 展示：

```text
Brief
Script
Storyboard
Media Plan
Publish Package
Review
XHS Package
```

每个 artifact 支持：

- 查看当前版本。
- 接受/拒绝建议 patch。
- 对比 AI 版本和用户编辑版本。
- 继续要求 RedClaw 自动推进下一步。

### Evidence And Memory

展示：

- 使用了哪些知识片段。
- 使用了哪些素材。
- 读取了哪些用户偏好。
- 哪些偏好只是当前项目临时偏好。
- 哪些学习项建议保存为长期偏好。

高影响长期记忆必须让用户确认。

## Persistence Plan

建议 SQLite 为主：

```text
redclaw_runs
redclaw_task_graphs
redclaw_task_nodes
redclaw_projects
redclaw_project_artifacts
redclaw_events
redclaw_memory_creator
redclaw_memory_platform
redclaw_memory_skill
redclaw_learning_candidates
redclaw_media_assets
redclaw_timeline_plans
```

文件存储：

```text
~/Library/Application Support/RedBox/redclaw/
├── projects/<project_id>/
│   ├── artifacts/
│   ├── media/
│   ├── exports/
│   └── run-bundles/
├── memory/
└── cache/
```

所有 workspace/file 名称必须使用 Windows-safe stem 规则，不能直接把外部 URL、平台 ID 或用户输入当路径。

## Performance Strategy

核心原则：UI 读状态，重活任务化。

- 页面首屏只加载 run/project summary，不加载全文、全素材、全转录。
- 使用 stale-while-revalidate，刷新失败保留最后一次成功快照。
- TaskGraph 节点异步执行，事件流增量推送状态。
- 视频导入立即显示基础元信息，转写、抽帧、场景检测后台执行。
- 预览使用 proxy 文件，导出使用原片。
- embedding、transcription、scene detection 按 hash 缓存。
- 素材搜索先 metadata/FTS 粗筛，再向量重排。
- 大 payload 存 artifact 文件，事件表只存 ref。
- SQLite 写事务短小，不持锁做文件 I/O、目录扫描、索引构建。
- Rust host CPU 重活使用 `spawn_blocking` 或 sidecar worker。
- 页面切换请求可取消或可忽略，旧请求不能覆盖新页面状态。

后台 Job：

```ts
type RedClawJob = {
  id: string
  type:
    | 'extract_knowledge'
    | 'generate_task_graph'
    | 'agent_run'
    | 'transcribe'
    | 'scene_detect'
    | 'match_assets'
    | 'render_video'
    | 'learning_extract'
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  progress: number
  inputRef: string
  resultRef?: string
  error?: string
}
```

## Implementation Sequence

这不是产品分期，而是一次完整落地时的安全执行顺序。每一步完成后都应能被验证，最终形成全链路闭环。

### Current Delivery Status

截至 2026-05-01，RedClaw scoped orchestration 已经具备端到端创作闭环的第一版：

- 用户在 RedClaw 输入任务后，可由 RedClaw 自动创建临时团队 run，而不是要求用户手动激活各 Agent。
- Team Planner 会生成固定 Agent 枚举和依赖图，Research、Insight、Script、Storyboard、Media、Editor、Publish、Review 按依赖顺序交接。
- RedClaw 子 Agent 会收到当前节点、上下游、平台、内容格式和任务图上下文。
- 创作项目会同步 runtime task 的 orchestration outputs，并在 Creation Workspace 中展示 Brief、Script、Storyboard、Media、Publish、Review。
- 用户可保存各 section 的人工编辑草稿，刷新后仍保留。
- Review Agent 产生的 learning candidates 可由用户接受或拒绝；接受后写入统一 RedClaw memory，而不是写入 Agent 私有记忆。
- Media section 可导出 `redclaw.mediaPlan.v1` 包，包含 `media-plan.json`、`rough-cut.ffconcat` 和 README；可用 ffmpeg 渲染第一版 rough cut。
- Publish section 可导出 `redclaw.publishPackage.v1` 包，包含 `publish-package.json`、`publish-package.md` 和 `cover-brief.md`。
- Review section 可导出 `redclaw.reviewReport.v1` 包，包含 `review-report.json` 和 `review-report.md`。
- 小红书 Agent 已补完整运行提示词边界，子 Agent 会读取 `node`、`skillProfiles`、上下游节点、平台和内容格式。
- Skill Profile 已从名称声明升级为 contract，包含 `instruction`、`inputContract`、`outputContract` 和评估维度。
- 小红书项目可导出 `redclaw.xhsPackage.v1` 包，包含 `xhs-package.json`、`xhs-package.md`、`carousel-layout.json` 和 `image-manifest.json`。
- 小红书子 Agent 输出会按对应 `outputContract` 做 artifact 校验；缺失 artifact、非 JSON artifact 或字段类型不匹配都会让节点不通过。
- 小红书交付包会附带 `redclaw.xhsDeterministicCompliance.v1` 确定性质检，先稳定拦截医疗、金融、法律确定性承诺和平台高风险表述，再交给 Compliance Agent 做语义复核。

当前新增/使用的 RedClaw orchestration IPC：

- `redclaw:orchestration-plan`
- `redclaw:orchestration-create-team`
- `redclaw:orchestration-create-run`
- `redclaw:orchestration-registry`
- `redclaw:list-projects`
- `redclaw:learning-candidate-update`
- `redclaw:project-section-update`
- `redclaw:media-plan-export`
- `redclaw:media-plan-render`
- `redclaw:publish-package-export`
- `redclaw:review-report-export`
- `redclaw:xhs-package-export`

仍未做的边界保持不变：不自动发布到平台，不自研完整剪辑器，不自研 ASR/OCR/编码器，不允许 Agent 静默写长期记忆。

### XHS Content Team Delivery

小红书不再复用视频语义里的 Storyboard / Media 作为主要角色。RedClaw Orchestrator 会根据 `contentFormat` 自动选择小红书团队：

```text
xhs_article
  -> Research
  -> Topic
  -> Note Architect
  -> Copy
  -> Editor
  -> Publish
  -> Compliance
  -> Review

xhs_image_text
  -> Research
  -> Topic
  -> Note Architect
  -> Copy
  -> Visual Director
  -> Image
  -> Layout
  -> Editor
  -> Publish
  -> Compliance
  -> Review

xhs_image_assets
  -> Research
  -> Topic
  -> Note Architect
  -> Copy
  -> Visual Director
  -> Image
  -> Layout
  -> Editor
  -> Publish
  -> Compliance
  -> Review
```

新增小红书角色：

| Agent | 职责 | 输出 |
|---|---|---|
| Topic Agent | 选题、爆点、人群痛点、搜索关键词、笔记类型判断 | `XhsTopicBrief` |
| Note Architect Agent | 文章/图文结构、段落角色、多图页目的和顺序 | `XhsNoteArchitecture` |
| Copy Agent | 标题、封面标题、正文、CTA、标签、评论引导 | `XhsCopyPackage` |
| Visual Director Agent | 封面方向、配图策略、图片 prompt、文字安全区 | `XhsVisualBrief` |
| Image Agent | 查找/生成/整理封面和配图资产，声明缺失资产 | `XhsImageAssets` |
| Layout Agent | 多图顺序、卡片文案、版式 manifest、移动端可读性 | `XhsCarouselLayout` |
| Compliance Agent | 小红书风险、敏感词、夸张承诺、商业合规检查 | `ComplianceReport` |

必须复用现成库/服务：

- 图片生成：使用用户配置的图片生成模型或 OpenAI Images 等 provider，不自研生成模型。
- 图片裁切、压缩、格式转换：使用 `sharp`、系统图像能力或现有 media pipeline，不手写编码器。
- OCR / 图片文字识别：使用现成 OCR provider，不自研 OCR。
- 视频/音频仍使用 ffmpeg / ffprobe / ASR provider，不自研底层媒体处理。

RedClaw 自研部分：

- `contentFormat` 到 team composition 的确定性映射。
- 小红书 AgentSpec / SkillProfile / output schema。
- 小红书图文结构、视觉 brief、图片资产 manifest、carousel layout manifest。
- 项目状态同步、section 草稿、学习候选、发布包、质检报告。
- 小红书交付包导出：`xhs-package` 聚合选题、结构、文案、视觉、图片、版式、合规、发布和复盘结果。
- 小红书 artifact contract 校验和确定性质检规则；这类规则需要可测试、可审计、可逐步扩展，不依赖前端专属页面。

### Step 1. Contracts

新增 RedClaw orchestration contracts：

- `RedClawRun`
- `TaskGraph`
- `TaskNode`
- `AgentSpec`
- `SkillProfile`
- `ProjectMemory`
- `ProjectPatch`
- `RedClawEvent`
- `LearningCandidate`

验收：

- TypeScript 和 Rust 类型能互相映射。
- 所有模型输出都有 schema。

### Step 2. Persistence

新增最小 SQLite store：

- run store
- task graph store
- project artifact store
- event log store
- memory store
- learning candidate store

验收：

- 创建 run 后重启应用仍可恢复。
- 事件可按 run/project 查询。
- 项目 artifact 可按版本读取。

### Step 3. Orchestrator And TaskGraph

实现：

- 用户任务 -> TaskGraph。
- 固定 Agent 枚举。
- 节点依赖校验。
- 节点状态机。
- 失败重试和取消。

验收：

- 输入示例任务后能生成包含 Research、Insight、Script、Publish、Review 的任务图。
- 依赖节点按顺序执行，无依赖节点可并发。

### Step 4. Agent Runner And Skill Runner

实现：

- AgentSpec registry。
- Skill registry。
- Context Builder。
- schema output validation。
- agent output -> ProjectPatch。

验收：

- Script Agent 不能调用 Media-only tool。
- Agent 输出不符合 schema 时被拒绝或 repair。
- Skill run 被记录到 EventLog。

### Step 5. Project State Machine

实现：

- CreativeProject。
- artifact versioning。
- ProjectPatch apply。
- rollback/compare 基础能力。

验收：

- 脚本、分镜、发布包都不是聊天文本，而是 project artifact。
- 用户刷新页面后 artifact 保留。

### Step 6. Memory Core And Learning Pipeline

实现：

- Creator Memory。
- Platform Memory。
- Skill Memory。
- Learning Candidate。
- Memory Write Policy。
- 用户确认高影响偏好。

验收：

- 用户选择/编辑标题会形成 event。
- 多次选择会形成 skill learning candidate。
- 长期 brand voice 写入需要确认。

### Step 7. Media Plan

实现：

- media probe。
- transcription job。
- asset indexing。
- storyboard -> required shots。
- asset matching。
- timeline plan。

验收：

- 本地素材能被匹配到脚本段落。
- 生成 timeline JSON。
- 缺失素材会明确列出，不硬凑。

### Step 8. RedClaw UI

实现：

- Command Bar。
- Team Run Timeline。
- Creation Workspace。
- Evidence And Memory panel。
- Learning confirmation panel。
- 通用 export action：按项目内容格式导出 media plan、publish package、review report 或 xhs package。

验收：

- 用户只发一个任务，UI 展示完整团队执行过程。
- 页面刷新不清空已有 run/project。
- 失败节点能展示原因和重试入口。
- 小红书任务不需要跳转到专属页面；在同一个 RedClaw 页面内可以看到团队执行、产物摘要、质检结果和导出入口。

### Step 9. Full Flow Verification

完整跑通：

```text
用户任务
  -> task graph
  -> research
  -> brief
  -> script
  -> storyboard
  -> media plan
  -> publish package
  -> review
  -> learning candidates
```

验收：

- 至少一条小红书口播视频任务全链路完成。
- 所有 Agent/Skill/Project/Memory 事件可追踪。
- 用户可确认或拒绝长期学习项。

## Verification Matrix

| 改动范围 | 最低验证 |
|---|---|
| Renderer RedClaw UI | 页面切换、刷新恢复、旧数据保留、失败态保留 |
| Bridge / IPC | 真实页面调用一次，不只测 Rust command |
| Orchestrator | 真实用户任务生成 TaskGraph 并执行 |
| Agent / Skill | 至少跑一轮真实任务，检查 schema、事件、tool 权限 |
| Memory | 检查 event -> candidate -> policy -> write 全链路 |
| Media | 至少 probe 一个视频、生成转写或 timeline plan |
| Persistence | 重启应用后恢复 run/project/artifact |

## Atomic Commit Plan

严格 Atomic Commits，一个提交只做一件事：

1. `docs: add redclaw orchestrated creative team plan`
2. `types: add redclaw orchestration contracts`
3. `persistence: add redclaw run and event stores`
4. `runtime: add redclaw task graph orchestrator`
5. `runtime: add redclaw agent and skill registries`
6. `runtime: add redclaw project state machine`
7. `runtime: add redclaw memory core`
8. `runtime: add redclaw learning pipeline`
9. `media: add redclaw media planning runtime`
10. `bridge: expose redclaw orchestration ipc`
11. `ui: add redclaw run timeline`
12. `ui: add redclaw creation workspace`
13. `ui: add redclaw memory confirmation panel`
14. `test: add redclaw orchestration regression coverage`

每个提交都必须能独立解释，不把 UI、runtime、persistence、media 混在同一个提交里。

## Non-Goals

当前不做：

- 自动发布到平台。
- 自研完整视频剪辑器内核。
- 自研 ASR/OCR/编码器。
- 让 Agent 自由互聊并互相改记忆。
- 让 Skill 自动改写自身 prompt 文件。
- 把所有长期偏好静默写入 memory。

## Open Decisions

需要在实现前确认：

1. RedClaw creative project 是否复用现有 manuscripts/media store，还是新增 redclaw_projects store 后做桥接。
2. Skill registry 是否放在现有 `skills/*` 体系内，还是先做 RedClaw scoped registry。
3. Media transcription 首选本地 Whisper、OpenAI API，还是按用户配置自动选择。
4. Learning candidate 的用户确认 UI 是全局通知，还是 RedClaw 页面内面板。
5. TaskGraph 是否复用当前 collaboration runtime 的 session/member/task，还是做 RedClaw scoped orchestration 后再桥接到 team UI。

## Recommendation

最优路线是：

```text
先实现 RedClaw scoped orchestration。
复用现有 collaboration runtime 的状态展示经验，但不要让 RedClaw 强依赖通用 team session。
Memory Core 统一按业务对象治理。
Agent 只作为临时岗位读取上下文。
Skill 版本稳定，使用策略通过 Skill Memory 进化。
所有真实副作用经 Tool/IPC/schema 执行。
```

这样 RedClaw 能在用户只发一个目标的情况下，自动组建团队完成完整创作链路，同时保持记忆、技能和项目状态可控、可审计、可持续进化。
