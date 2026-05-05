---
doc_type: plan
execution_status: not_started
last_updated: 2026-05-05
---

# Creative Template Skill System Plan

## 1. Goal

把 RedConvert 增加“模板”能力，但模板不做成静态 prompt 或表单。

模板的本质应是一个面向内容创作的 `creative_template` skill subtype：

- 官方可以内置模板。
- 用户可以从知识库内容拆解出模板。
- 模板可以约束文字、图片、图文、视频的制作流程。
- 模板可以根据用户反馈生成可审计、可回滚的迭代补丁。
- 模板运行结果可以进入 Manuscripts、Media、Video Editor 或 RedClaw。

本文定义的是可执行系统方案，不是 UI 灵感清单。默认按“底层 contract 先成立，UI 少量入口接入”的方式实施。

## 2. Product Position

RedConvert 当前内容链路应保持清晰：

```text
Knowledge     保存证据、素材、参考内容
Templates     抽象创作流程、约束产出结构
Manuscripts   承载文字、图文包、视频脚本
Media         承载图片、音频、视频素材
Video Editor  承载时间线和成片
RedClaw       承载复杂自动化、多步骤创作任务
```

模板不是新的内容孤岛。模板是 Knowledge 到 Manuscripts / Media / Video / RedClaw 的流程桥。

用户心智：

- “我想按这个模板写一篇。”
- “把这篇爆文拆成模板。”
- “这个模板以后别再写得这么营销。”
- “用这个模板做一条口播视频。”

系统心智：

- Template 定义 workflow。
- Runtime 执行 workflow。
- Knowledge 提供证据。
- Manuscripts / Media / Video 接收产物。
- Feedback 记录用户偏好和模板演进。

## 3. Recommended Direction

采用 **Template As Skill Bundle**。

不要采用纯 prompt 模板，也不要一开始把所有模板运行都丢给 RedClaw 多 Agent。

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. 纯 Prompt 模板 | 保存一段 prompt，用户选择后拼进对话 | 实现最快 | 不可验证、不可版本化、无法稳定接视频和反馈 | 不推荐 |
| B. Template As Skill Bundle | 模板是带 schema、workflow、prompt、examples、rubric 的 skill subtype | 稳定、可版本化、可评估、能接工具权限 | 需要新增 template loader/runtime | 推荐 |
| C. Template As RedClaw Task | 模板选择后直接由 RedClaw 组队执行 | 适合复杂任务 | 简单内容太重、启动慢、成本高 | 作为高级模式 |
| D. 模板市场式 UI | 做一个重模板中心，用户浏览大量卡片 | 看起来完整 | UI 膨胀，核心能力未必稳定 | 不作为第一优先级 |

最终选择：

- 基础能力采用 B。
- 复杂长链路执行时由模板声明 `executionMode: redclaw`，再交给 RedClaw。
- UI 只加必要入口，避免把模板功能做成一个解释性很重的新页面。

## 4. Target Architecture

```text
desktop/
├── builtin-skills/
│   └── templates/
│       ├── official-xhs-note/
│       │   ├── template.yaml
│       │   ├── system.md
│       │   ├── workflow.md
│       │   ├── rubrics/
│       │   │   └── review.yaml
│       │   └── examples/
│       │       ├── good.md
│       │       └── weak.md
│       └── official-short-video/
├── src-tauri/src/
│   ├── commands/templates.rs
│   ├── templates/
│   │   ├── mod.rs
│   │   ├── schema.rs
│   │   ├── loader.rs
│   │   ├── store.rs
│   │   ├── extractor.rs
│   │   ├── executor.rs
│   │   ├── feedback.rs
│   │   └── evaluator.rs
│   └── tools/app_cli.rs
└── src/
    ├── bridge/ipcRenderer.ts
    ├── pages/Templates.tsx
    ├── features/templates/
    │   ├── types.ts
    │   ├── api.ts
    │   ├── TemplatePicker.tsx
    │   ├── TemplateRunSheet.tsx
    │   └── TemplateFeedback.tsx
    └── pages/Knowledge.tsx
```

User templates should live in app data:

```text
~/Library/Application Support/RedBox/templates/
```

Official templates are read-only bundled assets. User templates are editable forks with their own versions.

## 5. Template Package Contract

Every template bundle must have `template.yaml`.

```yaml
id: official.xhs.note.v1
kind: creative_template
name: 小红书图文笔记
version: 1
origin: official
mediaTypes:
  - text
  - image
executionMode: direct
runtimeMode: creative-template
inputs:
  - id: topic
    label: 主题
    type: text
    required: true
  - id: source_materials
    label: 参考知识
    type: knowledge_refs
    required: false
  - id: audience
    label: 目标人群
    type: text
    required: false
outputs:
  - id: manuscript
    type: manuscript_markdown
  - id: image_brief
    type: image_prompt_pack
workflow:
  - id: evidence_read
    type: knowledge_read
  - id: angle_extract
    type: reasoning
  - id: outline
    type: writing_plan
  - id: draft
    type: writing
  - id: visual_brief
    type: image_brief
  - id: review
    type: quality_gate
tools:
  allow:
    - knowledge.read
    - manuscripts.writeCurrent
    - media.createBrief
feedback:
  patchable:
    - styleRules
    - workflow
    - rubrics
    - examples
```

Hard rules:

- `kind` must be `creative_template`.
- `id` must be stable and never reused for incompatible semantics.
- `version` increments on template structure changes.
- `mediaTypes` drives UI filtering and output adapters.
- `workflow` is structured data, not free-form prose.
- `tools.allow` is declarative and must be translated into existing canonical tool/action policy.
- Templates must never introduce new top-level model-visible tools just for one business domain.

## 6. Official Built-In Templates

First official set should be small and production-oriented:

1. 小红书图文笔记
2. 小红书口播视频
3. 知识卡片 / 长图
4. 教程文章
5. 产品介绍文案
6. 视频脚本分镜
7. 热点二创选题
8. 复盘型内容报告

Do not ship dozens of templates first. The first release should prove:

- one text-only template,
- one image + text template,
- one video-planning template,
- one knowledge-derived custom template.

Official templates are bundled resources. They should not be mutated by feedback. If the user wants to customize one, create a user fork:

```text
official.xhs.note.v1 -> user.<uuid>.xhs.note.v1
```

## 7. Knowledge To Template Extraction

The command `templates:create-from-knowledge` creates a draft template from one or more knowledge items.

### 7.1 Input

```json
{
  "sourceIds": ["knowledge-source-id"],
  "sourceBlockIds": ["optional-block-id"],
  "targetMediaTypes": ["text", "image"],
  "templateName": "optional user name",
  "saveMode": "draft"
}
```

### 7.2 Pipeline

```text
1. Resolve knowledge references
2. Read canonical indexed blocks
3. Build extraction evidence pack
4. Classify content pattern
5. Extract concrete structure
6. Abstract reusable workflow
7. Generate template.yaml draft
8. Generate system.md / workflow.md / review.yaml
9. Run schema validation
10. Run dry-run evaluation with a synthetic topic
11. Save draft template
```

This must consume knowledge index canonical blocks and evidence packs. Do not read raw files directly in the extractor. Raw file reads will fail or degrade for PDF, DOCX, images, OCR sources and web captures.

### 7.3 Extracted Structure

Extractor output:

```json
{
  "contentPattern": {
    "opening": "scene-first",
    "body": "problem-solution-proof",
    "ending": "soft-cta"
  },
  "styleRules": {
    "voice": ["direct", "observational"],
    "avoid": ["empty hype", "generic slogans"]
  },
  "visualRules": {
    "imageCount": "3-6",
    "imageRole": ["cover", "detail", "comparison"]
  },
  "workflow": [
    {"id": "angle", "type": "reasoning"},
    {"id": "outline", "type": "writing_plan"},
    {"id": "draft", "type": "writing"},
    {"id": "review", "type": "quality_gate"}
  ],
  "uncertainties": [
    "source has weak CTA evidence"
  ]
}
```

The extraction flow should store uncertainty instead of pretending every source can produce a perfect template.

## 8. Template Runtime

Add `creative-template` runtime mode.

Runtime responsibilities:

- Load one template bundle.
- Resolve input slots.
- Fetch minimal knowledge context.
- Compile workflow prompt.
- Expose only the needed tool actions.
- Execute workflow steps.
- Write output to the correct destination.
- Record run events and feedback hooks.

Runtime input:

```json
{
  "templateId": "official.xhs.note.v1",
  "templateVersion": 1,
  "inputs": {
    "topic": "如何做一个本地 AI 创作工作流",
    "audience": "内容创作者",
    "source_materials": ["knowledge://source-id"]
  },
  "outputTarget": {
    "type": "manuscript",
    "projectId": "optional"
  }
}
```

Runtime output:

```json
{
  "runId": "template-run-id",
  "status": "completed",
  "artifacts": [
    {
      "type": "manuscript",
      "uri": "manuscripts://..."
    },
    {
      "type": "image_prompt_pack",
      "uri": "media-brief://..."
    }
  ],
  "review": {
    "score": 0.82,
    "warnings": []
  }
}
```

### 8.1 Tool Exposure

Template runtime must use the existing canonical action pattern.

Allowed direct actions:

- `knowledge.read`
- `knowledge.search`
- `manuscripts.writeCurrent`
- `media.createBrief`
- `video.createScenePlan`
- `redclaw.createTask`

The exact action names should align with current `app_cli` / tool registry naming before implementation. The important rule is that templates declare capabilities and the runtime translates them into existing tool/action exposure. Do not create a new model-visible tool for every template type.

## 9. Feedback And Iteration

Feedback must not directly overwrite official templates.

Use three layers:

```text
Official Template
  read-only baseline

User Template Fork
  editable user-owned version

Template Learning Patch
  accumulated feedback-derived rules
```

### 9.1 Feedback Record

```json
{
  "id": "feedback-id",
  "templateId": "official.xhs.note.v1",
  "templateVersion": 1,
  "runId": "run-id",
  "signal": "user_comment",
  "target": "opening",
  "comment": "开头不要这么营销，直接给场景",
  "before": "你是不是也经常...",
  "after": "我最近发现一个更稳定的做法...",
  "createdAt": "2026-05-05T00:00:00Z"
}
```

### 9.2 Learning Patch

```yaml
templateId: official.xhs.note.v1
patchVersion: 3
styleOverrides:
  opening:
    avoid:
      - 夸张反问
      - 泛泛痛点
    prefer:
      - 具体场景
      - 先观察再下结论
rubricOverrides:
  penalties:
    - id: hype_opening
      weight: 0.2
```

Patch generation can be manual at first:

- User clicks “记住这个偏好”.
- Runtime stores feedback.
- `templates:generate-feedback-patch` proposes a patch.
- User accepts patch.
- Future runs load baseline template + accepted patches.

Do not silently mutate templates after every rejection. That will cause prompt drift and make regressions impossible to debug.

## 10. Video Template Handling

Video templates should generate structured scene plans first, not rendered videos.

```json
{
  "type": "video_scene_plan",
  "aspectRatio": "9:16",
  "scenes": [
    {
      "id": "scene-1",
      "durationSeconds": 3,
      "voiceover": "先看这个工作流最大的问题。",
      "visual": {
        "kind": "screen_recording",
        "description": "展示知识库到稿件的流转"
      },
      "caption": "素材不是越多越好"
    }
  ]
}
```

Must use existing libraries or existing product modules for:

- decoding,
- trimming,
- transcoding,
- timeline editing,
- waveform,
- rendering.

Template system only owns:

- video workflow structure,
- scene planning,
- asset requirements,
- caption and voiceover draft,
- handoff to video editor or RedClaw.

Do not self-build a video engine inside the template module.

## 11. UI Plan

UI should be minimal.

### 11.1 Entry Points

Add three entry points:

1. Knowledge detail action: `拆成模板`
2. Manuscript create action: `从模板创建`
3. Optional Templates page: lightweight management only

Do not add explanatory banners or a heavy template marketplace in the first release.

### 11.2 Template Picker

The picker should show:

- template name,
- media type icon,
- official / custom badge,
- last used time,
- one-line output type.

Avoid long descriptions. Use preview only after selection.

### 11.3 Template Run Sheet

Only ask for required inputs:

- topic,
- target audience,
- knowledge references,
- output destination.

Advanced fields stay collapsed. The template workflow should carry the complexity.

### 11.4 Feedback UI

Feedback should appear where users naturally review output:

- after manuscript generation,
- after image brief generation,
- after video scene plan generation.

Actions:

- `重写这一段`
- `记住这个偏好`
- `不要再这样写`
- `保存为我的模板`

Avoid a separate “训练模板” screen in the first version.

## 12. Persistence

Add a template store under app data with SQLite metadata and file-backed bundles.

```text
templates/
├── templates.sqlite
├── official-cache/
├── user/
│   └── <template-id>/
│       ├── template.yaml
│       ├── system.md
│       ├── workflow.md
│       ├── rubrics/
│       ├── examples/
│       └── versions/
└── runs/
    └── <run-id>.json
```

Suggested tables:

```sql
creative_templates(
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  media_types_json TEXT NOT NULL,
  bundle_path TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

creative_template_runs(
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

creative_template_feedback(
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  run_id TEXT,
  signal TEXT NOT NULL,
  target TEXT,
  before_text TEXT,
  after_text TEXT,
  comment TEXT,
  created_at TEXT NOT NULL
);

creative_template_patches(
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  patch_version INTEGER NOT NULL,
  patch_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT
);
```

## 13. IPC Contract

Add typed bridge methods in `desktop/src/bridge/ipcRenderer.ts`.

```ts
templates: {
  list(): Promise<TemplateSummary[]>
  get(id: string): Promise<TemplateDetail>
  createFromKnowledge(input: CreateTemplateFromKnowledgeInput): Promise<TemplateDraft>
  run(input: RunTemplateInput): Promise<TemplateRunResult>
  submitFeedback(input: SubmitTemplateFeedbackInput): Promise<TemplateFeedbackResult>
  generateFeedbackPatch(input: GenerateTemplatePatchInput): Promise<TemplatePatchDraft>
  acceptPatch(input: AcceptTemplatePatchInput): Promise<void>
  fork(input: ForkTemplateInput): Promise<TemplateDetail>
  archive(id: string): Promise<void>
}
```

The renderer must not call Tauri primitives directly.

## 14. Libraries Vs Self-Build

Must use existing libraries or product modules:

- JSON/YAML parsing and schema validation.
- Knowledge index canonical blocks and retrieval.
- File watching.
- Existing AI provider runtime.
- Existing tool registry / guard / action contract.
- Existing document parsing and OCR.
- FFmpeg / existing video editor modules for media operations.

Must self-build:

- creative template schema,
- template package loader,
- template workflow compiler,
- template extraction pipeline,
- template run store,
- feedback patch system,
- UI entry points and bridge contracts,
- handoff adapters to Manuscripts / Media / Video / RedClaw.

Must not build:

- a second knowledge parser,
- a second video engine,
- arbitrary plugin-like JS execution for templates,
- a separate tool system for templates,
- keyword-based intent routing.

## 15. Performance Strategy

Template listing:

- Read summaries from SQLite.
- Do not load full bundle files for list view.
- Cache official template manifest at startup.

Knowledge extraction:

- Run as background job.
- Use canonical block IDs and evidence packs.
- Cache by source fingerprint and target media type.
- Save uncertainties and extraction diagnostics.

Runtime execution:

- Load only the selected template.
- Inject only referenced knowledge blocks.
- Keep workflow step output structured.
- Persist run events incrementally.
- Keep long video scene planning async.

Feedback learning:

- Store raw feedback immediately.
- Generate patches asynchronously or by explicit user action.
- Apply accepted patches at prompt compile time.
- Never rewrite full template files on every run.

UI:

- Use stale-while-revalidate for template list.
- Preserve last successful list on refresh failure.
- Never block page open on template extraction or official bundle scan.

## 16. Security And Safety

Templates are declarative. They are not executable scripts.

Rules:

- No arbitrary JS/Rust/Python inside template bundles.
- Tools must be declared and approved through existing runtime guardrails.
- Official templates are signed or bundled read-only.
- User imported templates must be schema-validated before activation.
- Template output writes must go through existing Manuscripts / Media / Video commands.
- Feedback patches must be accepted before they affect future runs.

## 17. Implementation Steps

### Step 1: Template Schema And Loader

Files:

- `desktop/src-tauri/src/templates/schema.rs`
- `desktop/src-tauri/src/templates/loader.rs`
- `desktop/src-tauri/src/templates/mod.rs`
- `desktop/builtin-skills/templates/*`

Work:

- Define Rust structs for template manifest.
- Load official templates from bundled resources.
- Load user templates from app data.
- Validate required fields and workflow shape.
- Return `TemplateSummary` without loading full prompt files.

Acceptance:

- `templates:list` returns official templates.
- Invalid templates are skipped with diagnostics.
- Official templates remain read-only.

### Step 2: Store And IPC

Files:

- `desktop/src-tauri/src/templates/store.rs`
- `desktop/src-tauri/src/commands/templates.rs`
- `desktop/src-tauri/src/commands/mod.rs`
- `desktop/src/bridge/ipcRenderer.ts`
- `desktop/src/types.d.ts`

Work:

- Create SQLite tables.
- Add list/get/fork/archive commands.
- Add typed bridge methods.
- Preserve stale data on UI refresh failure.

Acceptance:

- Renderer can list and inspect templates through bridge.
- User can fork official template.
- Archived user template disappears from picker but remains recoverable in store until true delete is implemented.

### Step 3: Knowledge To Template Extractor

Files:

- `desktop/src-tauri/src/templates/extractor.rs`
- `desktop/src-tauri/src/commands/templates.rs`

Work:

- Resolve knowledge source/block references.
- Read canonical indexed blocks.
- Build evidence pack.
- Ask AI to extract pattern into structured JSON.
- Validate generated template bundle.
- Save as draft user template.

Acceptance:

- A knowledge item can produce a draft template.
- Draft includes workflow, inputs, outputs, rubrics and uncertainties.
- Extraction does not read raw files directly.

### Step 4: Template Runtime

Files:

- `desktop/src-tauri/src/templates/executor.rs`
- `desktop/src-tauri/src/runtime/*`
- `desktop/src-tauri/src/tools/plan.rs`
- `desktop/src-tauri/src/tools/app_cli.rs`

Work:

- Add `creative-template` runtime mode.
- Compile template prompt and workflow.
- Expose minimal tool actions.
- Run template and save artifacts.
- Persist run status and structured output.

Acceptance:

- Text template writes a manuscript.
- Image/text template writes manuscript plus image brief.
- Video template writes scene plan, not rendered video.
- Tool exposure remains minimal and action-based.

### Step 5: Feedback Patch Loop

Files:

- `desktop/src-tauri/src/templates/feedback.rs`
- `desktop/src-tauri/src/templates/evaluator.rs`
- `desktop/src-tauri/src/commands/templates.rs`

Work:

- Store user feedback records.
- Generate patch drafts from feedback.
- Allow accept/reject of patches.
- Apply accepted patches at runtime compile time.

Acceptance:

- User feedback affects future runs only after acceptance.
- Official template bundle is not mutated.
- Patch history is visible in diagnostics.

### Step 6: UI Integration

Files:

- `desktop/src/features/templates/*`
- `desktop/src/pages/Knowledge.tsx`
- `desktop/src/components/manuscripts/ManuscriptEditorHost.tsx`
- optional `desktop/src/pages/Templates.tsx`
- `desktop/src/App.tsx`
- `desktop/src/components/Layout.tsx`

Work:

- Add `拆成模板` action in knowledge detail.
- Add `从模板创建` in manuscript creation.
- Add minimal template picker and run sheet.
- Add feedback affordances near generated artifacts.
- Add optional compact Templates management page only if necessary.

Acceptance:

- User can create a manuscript from an official template.
- User can create a template from one knowledge item.
- User can submit feedback from generated output.
- No heavy explanatory UI is added.

### Step 7: RedClaw Handoff

Files:

- `desktop/src-tauri/src/templates/executor.rs`
- `desktop/src-tauri/src/commands/redclaw.rs`
- `desktop/src/pages/RedClaw.tsx`

Work:

- Let templates declare `executionMode: redclaw`.
- Convert template run into RedClaw task graph input.
- Attach template ID, version and accepted patches to RedClaw run metadata.

Acceptance:

- Complex video/content package template can start a RedClaw task.
- Simple templates still run directly.
- RedClaw transcript records template source and version.

## 18. Verification Matrix

Schema and loader:

- unit test valid official template loads.
- unit test invalid workflow is rejected.
- unit test user fork preserves official source reference.

Knowledge extraction:

- test extraction uses indexed blocks.
- test missing/empty evidence returns actionable error.
- test OCR/canonical block content can be used without raw file read.

Runtime:

- run text template once and verify manuscript output.
- run image/text template once and verify image brief artifact.
- run video template once and verify scene plan artifact.
- inspect event stream and tool exposure.

Feedback:

- submit feedback.
- generate patch.
- accept patch.
- rerun template and verify patch is included in compiled prompt.

Renderer:

- template list stale-while-revalidate.
- picker state preserved on refresh.
- knowledge detail action does not clear page data.
- manuscript create flow works after route switch and refresh.

## 19. Rollout And Risk

Do not ship this as a half-visible UI.

Minimum complete release:

- official template list,
- one official text template,
- one official image/text template,
- one official video scene-plan template,
- knowledge-to-template draft creation,
- template run to manuscript,
- feedback record and accepted patch support.

Risks:

- Template extraction may overfit one source.
- Feedback patch may cause style drift.
- UI can become too heavy if every template exposes many fields.
- Video templates can be misunderstood as full auto-rendering.

Mitigations:

- Store uncertainties.
- Require patch acceptance.
- Keep advanced inputs collapsed.
- Name video output as scene plan until rendering is explicitly requested.
- Keep official templates read-only.

## 20. Final Recommendation

Build templates as a first-class `creative_template` skill subtype.

This gives RedConvert a reusable creative workflow system without creating a second AI architecture. It also keeps the app aligned with the existing direction:

- skills/prompts define capability,
- typed metadata carries routing intent,
- tool/runtime enforce execution boundaries,
- knowledge index supplies evidence,
- Manuscripts/Media/Video receive artifacts,
- RedClaw handles complex orchestration.

The first implementation should be small in UI but complete in runtime. A user should be able to pick a template, generate a real artifact, turn a knowledge item into a draft template, and make feedback affect the next run through an accepted patch.
