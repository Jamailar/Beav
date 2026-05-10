# RedConvert Evidence Sources For WWUD

Use this map when deciding what the user would do.

## Profiles

- `profiles://user`: user-level identity, operating style, and persistent preferences.
- `profiles://creator_profile`: current creator/account positioning, audience, content goals, and expression boundaries.
- `Operate(resource="redclaw.profile", operation="bundle", input={})`: app-provided profile bundle when available.

## RedClaw

- Current RedClaw session metadata and task hints.
- Active skills listed in runtime context.
- Advisor/member skill references for member-specific role logic.
- Session transcripts and session bundles under the app support directory when debugging or reviewing actual execution.

## Creative Workflows

- Wander-selected materials and source directories.
- Manuscript current file, project metadata, and save target.
- Media/video/cover project files and generated artifacts.
- Knowledge retrieval results and source notes.

## Automation And Approvals

- Current automation prompt, schedule, run history, and approval queue item.
- Prior user approvals/rejections on the same automation.
- Whether the action is reversible and app-local.

## Learning Signals

Strong signals:

- direct correction from the user
- approved/rejected option
- repeated explicit preference across surfaces
- user asks to make a behavior the default

Weak signals:

- one-off wording preference
- old session behavior without a current matching context
- inferred taste from a different product surface
