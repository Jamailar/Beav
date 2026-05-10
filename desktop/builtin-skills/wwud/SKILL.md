---
name: wwud
description: 'What Would User Do for RedConvert. Infer how the current app user would decide, approve, reject, scope, phrase, prioritize, or route work inside RedClaw, automation approvals, creative workflows, manuscript/media decisions, advisor/member discussions, and product operations. Use when the model reaches a decision point that normally needs user judgment, and use after explicit user corrections so the app can learn the user role logic.'
allowedRuntimeModes: [redclaw, wander, chatroom, advisor-discussion, automation, long_running_task, default]
allowedTools: [resource, workflow]
hookMode: inline
autoActivate: false
activationScope: turn
activationHint: '当任务涉及审批、自动化选择、RedClaw 调度取舍、是否继续执行、创作方向判断、稿件/标题/封面/视频方案选择、成员角色观点模拟、范围收缩、发布前取舍，或用户明确问“我会怎么选/按我的习惯/替我判断/WWUD”时，调用 `Operate(resource="skills", operation="invoke", input={ "name": "wwud" })`。不要把 WWUD 当作授权；高风险动作仍必须回问用户。'
contextNote: 'WWUD 是当前 app 的用户判断模型技能。它应该优先读取当前空间的用户档案、创作者档案、advisor/member skill、知识库记忆、RedClaw 会话与自动化历史，从真实选择和纠正中推断用户的角色思路。它只负责辅助判断和记录学习，不替代用户授权。'
promptPrefix: '你当前已加载 WWUD。遇到需要用户判断的节点时，先把选择归类为 routine、material 或 restricted；再读取当前空间档案和任务上下文，推断用户最可能的选择。可读取 `profiles://user`、`profiles://creator_profile`，或调用 `Operate(resource="redclaw.profile", operation="bundle", input={})` 获取档案包；如果涉及成员/顾问，优先读取该成员 skill 或 advisor 上下文。输出必须包含 decision、confidence、evidence、risk、fallback。'
promptSuffix: 'WWUD 不能把推断当作授权。涉及外部发布、资金、凭据、删除、不可逆变更、合规/法律、向第三方发消息、生产部署或低置信高影响动作时，必须回问用户。用户给出确认、纠正或选择后，把可泛化的判断规则整理成 learn 观察，供后续写入用户模型。'
maxPromptChars: 9000
---

# WWUD for RedConvert

WWUD means "What Would User Do". Use it to make RedConvert's AI decisions closer to the current user's real judgment, role logic, taste, and operating habits.

WWUD has two jobs:

- **Decide**: infer the user's likely choice at a decision point.
- **Learn**: turn user confirmations, corrections, rejections, and approvals into future decision rules.

## App-Specific Context Sources

Use the most specific available source first:

1. Current user message and task metadata.
2. Current RedClaw / Wander / chat session context.
3. `profiles://user` and `profiles://creator_profile`.
4. `Operate(resource="redclaw.profile", operation="bundle", input={})`.
5. Active advisor/member skill when the task asks how a role would judge.
6. Knowledge files, manuscript state, current media/project files, and approval queue details.
7. Session transcripts, session bundles, automation history, and prior decision logs when available.

Do not use generic personality guessing when app-local evidence exists.

## Decision Classes

- **Routine**: wording, ordering, compact UI choice, reversible draft direction, low-risk internal routing.
- **Material**: architecture, user-visible product behavior, creative direction, publishing preparation, automation approval, non-trivial time/cost tradeoff.
- **Restricted**: irreversible deletion, external publish/send, production deployment, money, credentials, account permissions, privacy exposure, legal/compliance, or any hard-to-undo action.

Decide routine choices when confidence is medium or high. Decide material choices only when confidence is high and reversible. Escalate restricted choices.

## RedConvert Preference Model

Prefer these defaults unless fresher user evidence says otherwise:

- Finish the actual job once execution starts; avoid stopping at abstract advice after the user says continue, fix, execute, or complete.
- Make repo-, file-, page-, artifact-, or workflow-specific decisions instead of generic recommendations.
- Inspect real evidence before diagnosing: code, logs, state stores, transcripts, bundles, generated files, app data, and UI behavior.
- Keep UI additions small, intuitive, and low-text. Prefer existing surfaces over new pages.
- Respect strong scope boundaries. If the user corrects the boundary, treat the correction as high-priority evidence.
- Use existing app primitives: RedClaw orchestration, advisor/member skills, profiles, manuscripts, media tools, knowledge retrieval, automation queue, and `skills.invoke`.
- Avoid keyword-forced routing. Prefer typed task metadata, active skills, explicit user choice, and runtime contracts.
- Keep changes atomic. Do not bundle unrelated fixes or generated side effects into one decision.

## Decide Workflow

1. State the decision point in one sentence.
2. Classify it as routine, material, or restricted.
3. Read the narrowest relevant app evidence.
4. Compare options against the user model.
5. Return:

```text
decision: ...
confidence: high|medium|low
evidence:
- ...
risk: ...
fallback: ...
learn: optional observation if this outcome should update the model
```

For UI-facing or chat-facing answers, keep the wording natural and concise, but preserve the same fields when the decision affects execution.

## Learn Workflow

Record learning when the user:

- approves or rejects an automation item
- changes a RedClaw plan or route
- corrects a product/architecture boundary
- chooses one creative direction over another
- says a UI is too much, too verbose, too hidden, too abstract, or off-brand
- asks for a workflow to behave differently next time
- tells a member/advisor how it should think or speak

The learning event must include:

- `source`: where the observation came from
- `decision`: what was being decided
- `chosen`: what the user preferred
- `rejected`: what the user moved away from
- `principle`: the reusable rule
- `confidence`: high, medium, or low
- `expires`: optional, when the rule is likely temporary

Do not turn a one-off exception into a global rule unless the user frames it as a rule.

## Role Logic

When asked to decide as a role, separate three layers:

- **User logic**: what the app owner/operator/user tends to choose.
- **Creator profile logic**: what the current content account or project should choose.
- **Member/advisor logic**: what this specific simulated role would argue.

If these conflict, surface the conflict instead of blending them into a vague compromise.

## Safety Boundary

WWUD is not authorization. It may recommend, rank, or prepare an action. It may not silently execute restricted actions.

When the right answer is to ask, ask one precise question and include the default you would choose if the user delegates it.
