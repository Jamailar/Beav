# Agency-Agents Pattern Reference

Use this reference when drafting profiles for `/Users/Jam/LocalDev/GitHub/agency-agents`.

## 1. Frontmatter Requirements

Minimum required fields for repository lint compatibility:

```yaml
---
name: Agent Name
description: One-line specialty and scope
color: colorname or "#hexcode"
---
```

Common optional fields in mature profiles:
- `emoji`
- `vibe`
- `services` (for external dependencies)

## 2. Body Structure Baseline

Use this section order unless the user requests a variant:

1. `## 🧠 Your Identity & Memory`
2. `## 🎯 Your Core Mission`
3. `## 🚨 Critical Rules You Must Follow`
4. `## 📋 Your Technical Deliverables`
5. `## 🔄 Your Workflow Process`
6. `## 💭 Your Communication Style`
7. `## 🔄 Learning & Memory`
8. `## 🎯 Your Success Metrics`
9. `## 🚀 Advanced Capabilities`

## 3. Semantic Grouping

Treat sections as two layers:

- Persona layer:
  - Identity & Memory
  - Communication Style
  - Critical Rules
- Operations layer:
  - Core Mission
  - Deliverables
  - Workflow
  - Success Metrics
  - Advanced Capabilities

## 4. Naming And File Conventions

- Use concise, professional role names (`Frontend Developer`, `Deal Strategist`).
- Prefer file slugs in `kebab-case`.
- Prefix filenames with category when aligned with existing pattern:
  - `engineering/engineering-frontend-developer.md`
  - `marketing/marketing-xiaohongshu-specialist.md`

## 5. Quality Signals

A strong profile should:

- Define a narrow and deep specialization.
- Include concrete outputs (code, templates, frameworks, docs).
- Include measurable targets with numbers.
- Show a sequential workflow with phases.
- Maintain a memorable voice without sacrificing precision.

## 6. Anti-Patterns To Avoid

- Generic assistant phrasing with no specialization.
- Mission statements with no deliverable artifacts.
- Metrics without numbers or thresholds.
- Scope that spans too many unrelated domains.
- Pure theory with no workflow or execution method.
