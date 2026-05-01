---
doc_type: architecture
last_updated: 2026-05-01
---

# Human Approval Runtime

Human approval is a shared runtime capability, not a page-local inbox. The user-facing page is `审批`; the durable record is `ReviewDocketRecord`.

## Renderer Helper

Use `desktop/src/utils/humanApproval.ts` when a renderer module needs human approval:

- `buildHumanApprovalDocketPayload(input)`: normalize and validate payload shape.
- `createHumanApprovalDocket(input)`: create a generic approval docket.
- `createCollabTaskCompletionApprovalDocket(input)`: create the standard collaboration-task completion review.

Modules should prefer these helpers over directly calling `window.ipcRenderer.teamRuntime.createReviewDocket`.

## Proposed Action Schema

Every docket that should drive business state should set `proposedAction.kind`. Current registered kinds:

- `collab_task_completion`: collaboration task completion review. The collaboration task status is already updated by `onDecisionTaskStatus`.
- `redclaw_task_draft`: RedClaw task draft confirmation. Approval confirms the draft; rejection discards it.

Reserved next kinds:

- `manuscript_publish`
- `media_generation_result`
- `plugin_import_batch`

## Current Producers

- Collaboration Workboard: manual task completion review.
- Subagent spawner: automatic completion claim review.
- RedClaw task control: non-manual task draft review.

## Decision Effects

For dockets linked to a collaboration task, the runtime pauses the task at `waiting_for_review`. On decision, `proposedAction.onDecisionTaskStatus` maps approval outcomes back to task status.

Default collaboration completion mapping:

```text
approved -> completed
rejected -> failed
changes_requested -> claimed
```

RedClaw draft approvals use `proposedAction.kind = redclaw_task_draft`; approval confirms the draft, rejection discards it.

Decision routing is centralized in the Rust approval action router. Unknown `proposedAction.kind` values are recorded as unsupported action results instead of being treated as implicit success.
