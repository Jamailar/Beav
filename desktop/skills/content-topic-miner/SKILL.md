---
name: content-topic-miner
description: Extract self-media topic directions from source materials by classifying information value, finding useful or surprising points, converting facts into user-perceived questions, judging topic value, and outputting standardized topic data. Use when the user asks to find, refine, evaluate, or generate 自媒体选题 / content topics / article directions / short-video topic directions from notes, reports, transcripts, bookmarks, cases, user comments, market material, or messy research sources.
allowed-tools: [bash, redbox_fs]
---

# content-topic-miner

Use this skill to turn raw material into a content topic: a user-perceived problem, view, or direction that can be expressed in content.

Do not start from titles. Start from what the material makes worth knowing, understanding, using, judging, saving, debating, or feeling.

## Core Workflow

Process source material in this order:

1. Collect and scope the material.
2. Classify the value type.
3. Find extractable points.
4. Convert material points into user questions.
5. Distill the core problem or view.
6. Judge topic value.

If sources are large, first skim headings, summaries, tables, comments, transcript timestamps, filenames, and repeated terms. Then read only the most promising chunks deeply.

## Value Classification

Classify each useful source or chunk into one or more value types:

| Material value | Best content form |
| --- | --- |
| New knowledge | Explainer, introduction, beginner guide |
| Method | Tutorial, steps, checklist |
| Viewpoint | Commentary, insight, contrarian view |
| Case | Breakdown, retrospective, story |
| Data | Trend analysis, decision evidence |
| Resource | Collection, booklist, tool list |
| Conflict | Debate, comparison, opinion piece |
| Emotion | Resonance, life observation, value expression |

Ignore chunks that are only background, repetition, slogan, or title bait without a useful user-facing problem.

## Extractable Points

Look for six kinds of topic raw material:

- New information: something users may not know, overlooked facts, "原来如此" moments.
- Counterintuitive insight: "people think A, but actually B".
- Frequent problem: repeated confusion, search intent, comment pain, beginner blocker.
- Actionable method: steps, frameworks, checklists, procedures users can execute.
- Reusable model: logic that can transfer across scenes, industries, or accounts.
- Emotion or identity: anxiety, desire, confusion, frustration, ambition, or "this is me" recognition.

Prefer points that combine at least two categories, such as counterintuitive plus frequent problem, or method plus reusable model.

## User Question Conversion

Convert facts into user-perceived problems with this chain:

```text
material fact -> user confusion or desire -> content topic
```

Examples:

| Material fact | User question | Topic |
| --- | --- | --- |
| Creators collect many materials but cannot extract topics. | I have many notes, why do I still not know what to write? | Why do you collect so much material but still cannot find a topic? |
| One topic can be packaged into many titles. | Should I think about the title first? | What is the difference between a topic and a title? |
| Viral content often comes from systematic user-problem analysis, not pure inspiration. | How do I produce content consistently? | For self-media, the real skill is not inspiration but a topic system. |

Force every candidate through this conversion. If no user question emerges, mark it as weak or background material.

## Topic Value Test

A strong topic should satisfy these conditions:

- Clear user: name who it is for, such as beginner creators, local merchants, parents, students, knowledge workers, or account operators.
- Specific problem: avoid broad themes like "some thoughts on content creation".
- Expansion room: support more than a one-sentence answer.
- Distribution hook: pain point, counterintuitive claim, mistake, method, comparison, list, debate, trend, or emotional resonance.
- Long-term fit: strengthen the account label and support future series, knowledge base, product, service, course, checklist, or template.

Reject or downgrade candidates when they only have a catchy title, cannot be supported by the source, depend on unverifiable claims, or do not fit the user's positioning.

## Content Type Selection

Choose the content type by the user question:

| Type | Question pattern |
| --- | --- |
| Explainer | What is this? Why does it happen? |
| Method | How do I do it? |
| Pitfall | Where do people go wrong? |
| Comparison | What is the difference between A and B? |
| List | What options, tools, or resources exist? |
| Breakdown | Why did this succeed or fail? |
| Opinion | What should we think about it? |
| Retrospective | What can I learn from this? |
| Trend | What does this imply next? |

Do not choose a content type because it sounds attractive. Choose it because it matches the strongest user question.

## Output Shape

When mining topics from material, produce this structure:

```markdown
**Material Read**
- Value types: <knowledge/method/view/case/data/resource/conflict/emotion>
- Strongest extractable points: <3-6 bullets>

**Topic Candidates**
| Score | Topic | User | User question | Hook | Content type | Source support |
| --- | --- | --- | --- | --- | --- | --- |
| 9/10 | ... | ... | ... | ... | ... | ... |

**Recommended Topic**
- Topic: <one specific topic>
- Core view: <one sentence the audience should remember>
- Why this wins: <user pain + source support + distribution hook + long-term fit>

**Weak Or Rejected Points**
- <candidate>: <why it is weak or unsafe>
```

For quick requests, keep only `Topic Candidates` and `Recommended Topic`.

Always end with a machine-readable `Final Topic Data` JSON object for the recommended topic. Use this exact schema and keep every value as a string except `source`, which is an object:

```json
{
  "topic_name": "",
  "source": {
    "type": "",
    "description": ""
  },
  "target_audience": "",
  "user_problem": "",
  "core_insight": "",
  "content_value": "",
  "selection_reason": ""
}
```

Field rules:

- `topic_name`: internal topic direction name, not a public title.
- `source.type`: source category, such as report, transcript, note, comment, case, dataset, article, bookmark, interview, or mixed.
- `source.description`: concise traceable source description; include filename, URL label, author, platform, date, timestamp, or section when available.
- `target_audience`: the specific audience this topic serves.
- `user_problem`: the audience's confusion, need, decision, action blocker, or thing they want to understand.
- `core_insight`: the key judgment behind this topic; not the full article thesis or final copy.
- `content_value`: what the user gains after consuming the content, such as understanding, method, judgment basis, checklist, emotional resonance, or resource.
- `selection_reason`: why this topic is worth producing now, tying together source support, user demand, distribution hook, and long-term positioning.

## Quality Bar

- Keep topics source-grounded. Do not invent checkable facts not present in the material.
- Prefer one precise user problem over ten vague directions.
- State uncertainty when source support is thin.
- Separate `topic_name`, `user_problem`, `core_insight`, `content_value`, and `selection_reason`.
- Do not generate public titles, outlines, scripts, or finished content unless the user explicitly asks for that in a separate step.
- Make the output immediately usable as structured topic data for article, short-video, carousel, podcast, or script planning.
