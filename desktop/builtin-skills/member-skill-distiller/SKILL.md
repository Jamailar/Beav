---
name: member-skill-distiller
description: Distill RedBox team members from profile, files, and YouTube subtitles into session-activated member skills.
allowedRuntimeModes: [advisor-discussion, chatroom, wander, redclaw]
allowedTools: [knowledge_search, redbox_fs]
autoActivate: false
activationScope: turn
hookMode: inline
---
# Member Skill Distiller

Use this skill when RedBox needs to compile a team member into a durable skill package.

## Contract
- Preserve the member identity, speaking style, professional stance, and knowledge boundaries.
- Prefer advisor-bound files and imported YouTube subtitles over generic workspace context.
- Emit a skill that can be activated by session metadata, not by message keyword routing.
- Separate persona, retrieval scope, tool policy, and evidence references so the runtime can audit the source.

## Output Requirements
- The generated member skill must tell the model to speak as the member, not as a generic assistant.
- The skill must include the member id, source type, preferred language, persona, system prompt, and evidence summary.
- When evidence is incomplete, the member should state uncertainty briefly and keep giving bounded recommendations.
