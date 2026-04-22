---
name: agent-persona-creator
description: Design and draft AI agent persona documents for agent marketplaces, especially agency-agents style profiles. Use when asked to create or refine role setting docs, define identity/personality/mission/workflow/metrics, choose category and filename conventions, or convert a rough role brief into a production-ready agent markdown file.
---

# Agent Persona Creator

## Overview

Create high-quality, marketplace-ready AI agent profiles from a rough role brief.
Follow the agency-agents structure, keep persona distinctive, and make deliverables measurable.

## Inputs To Collect

Collect the minimum brief before drafting:
- Primary domain and narrow scope (one lane, not general assistant)
- Target users and typical requests
- Expected deliverables (code, strategy doc, checklist, report, playbook)
- Hard constraints (policy, stack, compliance, timeline, budget)
- Success metrics with numeric thresholds
- Preferred tone/voice and language

If the brief is incomplete, infer sensible defaults and mark assumptions explicitly.

## Workflow

### Step 1: Frame The Agent

- Choose a category folder aligned with the domain (engineering, marketing, specialized, etc.).
- Define one precise role sentence and one memorable vibe hook.
- Reject broad scopes that cannot be measured.

### Step 2: Build Persona Layer

- Write Identity & Memory with four concrete parts: Role, Personality, Memory, Experience.
- Write Communication Style with explicit tone rules and phrase patterns.
- Add Critical Rules as non-negotiable constraints and decision guardrails.
- Keep personality specific and operationally useful.

### Step 3: Build Operations Layer

- Write Core Mission as 3-5 responsibility bullets with clear outcomes.
- Write Technical Deliverables as concrete artifacts, not abstract help.
- Write Workflow Process in sequential phases with observable outputs.
- Write Success Metrics with quantitative targets and quality indicators.
- Write Advanced Capabilities as truly differentiated methods.

### Step 4: Produce Draft

- Use `scripts/create_agent_profile.py` to scaffold a compliant markdown file quickly.
- Fill placeholders with domain-specific details from the brief.
- Keep language aligned with the user's preferred language.

### Step 5: Self-Review Before Handover

- Verify frontmatter includes `name`, `description`, and `color`.
- Verify sections include Identity, Core Mission, Critical Rules, Deliverables, Workflow, Communication, Learning, Metrics, Advanced Capabilities.
- Verify at least one measurable KPI has a number and threshold.
- Verify no generic filler such as "I am a helpful assistant."

If drafting for the agency-agents repository, run:
```bash
bash scripts/lint-agents.sh <path-to-agent-file>
```

## Reference Map

- Read `references/agency-agents-patterns.md` for repository-specific structure and naming rules.
- Read `references/persona-design-canvas.md` to sharpen positioning, tone, and measurable outcomes.

## Output Contract

Return a complete markdown agent file that includes:
- Valid frontmatter
- Distinctive persona
- Concrete operational workflow
- Measurable success metrics
- Ready-to-save file path suggestion

If assumptions are necessary, include an `Assumptions` section at the end with concise bullets.
