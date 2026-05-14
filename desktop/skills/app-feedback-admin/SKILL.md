---
name: app-feedback-admin
description: Read platform-admin feedback issues through the trusted HTTP admin API, summarize user reports, and turn them into RedBox/RedConvert repair and iteration plans. Use when the user asks to read app feedback, triage feedback tickets, inspect remote feedback context, or prepare fix/iteration plans from feedback. This skill must keep FEEDBACK_ADMIN_API_KEY server-side/local only and must not place it in app UI, frontend code, desktop client code, logs, commits, or shared artifacts.
allowed-tools: [bash, redbox_fs]
---
# app-feedback-admin

Use this skill to read remote feedback tickets and convert them into concrete RedBox/RedConvert repair and iteration work.

Activate this skill when the user asks to read app feedback, process feedback tickets, inspect remote feedback context, or turn feedback into a repair or iteration plan.

## Hard Boundaries

- Never put `FEEDBACK_ADMIN_API_KEY` into desktop app code, renderer UI, frontend bundles, committed docs, screenshots, transcripts, or generated plans.
- Treat the feedback API as an operator-only channel. It is suitable for local scripts, CI/ops jobs, or trusted server automation only.
- Default to read-only triage. Do not update ticket status, add comments, or review/reward feedback unless the user explicitly asks for a write action in the current turn.
- Do not infer product root cause only from the ticket text. For bugs, cross-check RedBox code and local runtime evidence where relevant, especially `~/Library/Application Support/RedBox/session-transcripts/`, `session-bundles/`, and state DB/files.

## Local Environment

Use the ignored env file at repo root:

```text
.redbox-dev/feedback-admin.env
```

Expected variables:

```bash
API_BASE="https://..."
FEEDBACK_ADMIN_API_KEY="..."
FEEDBACK_APP_SLUG="xitun"
```

If the env file is missing or incomplete, stop and ask the user for the missing local configuration. Do not invent an API base or app slug.

## Read Workflow

1. Load the local env file without printing secrets.
2. Fetch the newest feedback list:

```bash
python3 desktop/skills/app-feedback-admin/scripts/fetch_feedback.py list --page-size 20
```

3. For tickets that look actionable, fetch details:

```bash
python3 desktop/skills/app-feedback-admin/scripts/fetch_feedback.py detail <feedback_id>
```

4. Classify each ticket into one of:
   - `bug`: reproducible product failure, crash, wrong result, data loss, broken workflow.
   - `ux`: confusing UI, missing affordance, excessive friction.
   - `feature`: new capability or workflow expansion.
   - `ops`: account, billing, deployment, API, notification, or backend process issue.
   - `invalid`: duplicate, unclear, spam, unsupported, or not enough evidence.
5. Map actionable items to RedBox modules:
   - desktop UI: `desktop/src/pages/*`, `desktop/src/components/*`, `desktop/src/bridge/ipcRenderer.ts`
   - Tauri host: `desktop/src-tauri/src/commands/*`, `runtime/*`, `persistence/*`, `events/*`
   - AI runtime: `desktop/src-tauri/src/agent/*`, `skills/*`, `tools/*`, `mcp/*`, `subagents/*`
   - media/video: `desktop/src-tauri/src/media*`, editor/runtime files
   - plugin intake: `Plugin/*`
   - website/release: `RedBoxweb/*`, `private/scripts/hybrid-release/*`
6. Produce a concrete plan, not loose advice. Include ticket ids, severity, evidence, suspected module, implementation target files, verification steps, and whether it is a fix or product iteration.

## Output Shape

Use this shape unless the user asks for a different one:

```markdown
**Feedback Triage**
- <id>: <status/priority> <classification> - <one-line user problem>

**Repair Plan**
- <module>: <specific fix>, files: <paths>, verification: <checks>

**Iteration Plan**
- <module>: <specific product improvement>, files/docs: <paths>, risk: <risk>

**Needs User Decision**
- <question or tradeoff, only when blocked>
```

Keep user-facing wording concise. Prefer evidence and next actions over explanatory text.

## Optional Write Actions

Only after explicit user approval, use the admin API to:

- add internal comments for investigation notes,
- add user-visible replies,
- update status/priority/category,
- review as `useless`, `thanks`, or `useful`.

Write actions must include a short audit note and must not expose secrets.
