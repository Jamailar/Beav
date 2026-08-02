# WWUD RedConvert Model Schema

Store learned preferences as compact, evidence-backed rules.

## Model Sections

- `identity`: user role, operator role, creator role, and active workspace.
- `decision_defaults`: stable rules that apply across the app.
- `surface_preferences`: per-surface rules for RedClaw, Wander, chat, automation, manuscript editor, media/video, settings, skills, and release flows.
- `role_models`: creator profiles, advisor/member reasoning style, and known boundaries.
- `approval_policy`: what can be inferred, what must be escalated, and what evidence is required.
- `learning_events`: append-only observations from approvals, corrections, and choices.

## Event Shape

```json
{
  "source": "redclaw|wander|automation|chat|advisor|manuscript|media|settings|release",
  "decision": "short decision context",
  "chosen": "preferred option",
  "rejected": "rejected option or n/a",
  "principle": "generalized rule",
  "confidence": "high|medium|low",
  "evidence": "short quote, session id, file path, or artifact link",
  "createdAt": "ISO-8601",
  "expires": null
}
```

## Confidence Rules

- `high`: directly stated user rule, repeated behavior, or fresh correction on the same surface.
- `medium`: strong pattern from adjacent app workflow.
- `low`: weak analogy, stale memory, or conflicting role requirements.

## Required Escalation

Always ask the user before:

- external publish/send
- production deployment or public release
- paid spend or subscription changes
- credential, secret, account, permission, or region/account-realm changes
- irreversible deletion or destructive migration
- legal, compliance, medical, tax, or privacy-sensitive decisions
- decisions where a wrong action is hard to undo
